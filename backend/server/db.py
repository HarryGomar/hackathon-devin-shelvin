"""Postgres for products, their pages, scrape runs, listings and scraper builds; on when DATABASE_URL is set.

The schema is defined with Drizzle in backend/db/schema.ts; `npm run generate` (in backend/db) writes its SQL
migrations to backend/db/drizzle/, and `migrate` here applies them in journal order, recording each tag in
`schema_migrations`.
Every method opens a short connection and one transaction: simple, and plenty for a small team.
Reads return the contract's shapes (ProductIdentity, SourcePage, Listing, ScanSummary), so the endpoints can serve
them as they come.

    uv run python -m server.db migrate        # apply new migrations to DATABASE_URL
    uv run python -m server.db import-builds DATA_DIR ...   # builds a JSON store recorded, into Postgres

Builds are written here as they happen too (one row, its attempts, every event), so the app can trace each one.
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from .kit import domain_of
from .photo import shareable
from .products import (barcode_digits, choose, gtin_of_id, line_key, merge_identity, name_key, name_keys,
                       normalize_gtin)

MIGRATIONS = Path(__file__).resolve().parents[1] / "db" / "drizzle"
BREAKPOINT = "--> statement-breakpoint"
# Databases created before Drizzle recorded the hand-written schema as 001_init.sql. Drizzle's first migration
# creates exactly that schema, so those databases take its tag as applied instead of running it again.
BASELINES = {"0000_init": "001_init.sql"}
# drizzle-kit writes REFERENCES "public"."products"(...). Unqualified, the tables land wherever search_path points:
# the per-test schemas, and public everywhere else.
PUBLIC_QUALIFIER = re.compile(r'"public"\.')

PRODUCT_COLUMNS = {"id": "id", "brand": "brand", "productName": "product_name", "variant": "variant", "size": "size",
                   "barcode": "barcode", "manufacturer": "manufacturer", "categoryGuess": "category",
                   "imageUrl": "image_url", "imageSource": "image_source", "source": "source",
                   "confidence": "confidence"}
PAGE_KEYS = {"id", "url", "domain", "retailerName", "sourceType", "title", "matchType", "verification", "scraper",
             "access", "productId", "searchId"}
LISTING_KEYS = {"id", "pageId", "url", "domain", "retailerName", "title", "price", "imageUrl", "fields", "scrapedAt"}


def _iso(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return value


def _drop_none(record):
    return {k: v for k, v in record.items() if v is not None}


class Database:
    def __init__(self, url, schema=None, migrations=MIGRATIONS):
        self.url, self.schema, self.migrations = url, schema, Path(migrations)

    def connect(self):
        import psycopg
        from psycopg.rows import dict_row
        options = f"-c search_path={self.schema}" if self.schema else None
        # A database that is down answers within seconds, so a build waits that long per event, not psycopg's minutes.
        return psycopg.connect(self.url, row_factory=dict_row, connect_timeout=5, **({"options": options} if options else {}))

    # --- schema ----------------------------------------------------------------------------------------------
    def migrate(self):
        """Apply Drizzle's generated migrations not yet in schema_migrations, one transaction each. Returns the new tags.

        This is the only migration tracker: `drizzle-kit migrate` (and its __drizzle_migrations table) stays out of
        the loop, so drizzle-kit only generates the SQL and the server applies it.
        """
        applied = []
        with self.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations "
                         "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            conn.commit()
            done = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
            for tag, path in self.journal():
                if tag in done:
                    continue
                with conn.transaction():
                    if BASELINES.get(tag) not in done:
                        for statement in self.statements(path):
                            conn.execute(statement)
                    conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (tag,))
                applied.append(tag)
        self.moved = self.dedupe()
        return applied

    def journal(self):
        """(tag, sql path) for each migration in drizzle/meta/_journal.json, in the order drizzle-kit wrote them."""
        entries = json.loads((self.migrations / "meta" / "_journal.json").read_text(encoding="utf-8"))["entries"]
        return [(e["tag"], self.migrations / f"{e['tag']}.sql") for e in sorted(entries, key=lambda e: e["idx"])]

    @staticmethod
    def statements(path):
        """The statements of one generated file, split where drizzle-kit marks them."""
        sql = PUBLIC_QUALIFIER.sub("", path.read_text(encoding="utf-8"))
        return [part.strip() for part in sql.split(BREAKPOINT) if part.strip()]

    def dedupe(self):
        """Give every product its gtin and name_key and fold duplicates together (the data step of
        0002_products_by_gtin, in Python so it shares server/products.py with the writes).

        Each product without a name_key yet is saved again over itself, oldest first, through the same choice as a
        new write: one with a valid barcode moves to `gtin-<GTIN-14>`, and stored products that are the same one fold
        into it (pages, searches, scrape runs and listings repointed, the old ids kept as aliases). Idempotent: a
        database where every product has its keys is left alone. Returns {old id: new id} for what moved.
        """
        moved = {}
        with self.connect() as conn:
            self._lock(conn)
            pending = [r["id"] for r in conn.execute(
                "SELECT id FROM products WHERE name_key IS NULL ORDER BY updated_at, id")]
            for product_id in pending:
                row = conn.execute("SELECT * FROM products WHERE id = %s", (product_id,)).fetchone()
                if row is None or row["name_key"] is not None:
                    continue   # folded into another, or rewritten as a target already
                target, folded = self._save_identity(conn, self._identity(row), stored=row)
                moved.update({old: target for old in folded})
            for old, new in list(moved.items()):   # a target that later moved again
                while new in moved:
                    new = moved[new]
                moved[old] = new
        return moved

    # --- writes ----------------------------------------------------------------------------------------------
    def save_product(self, product, conn=None):
        """Save a ProductIdentity under its canonical id and return the stored identity (its `id` may differ).

        The id is chosen by server/products.py: `gtin-<GTIN-14>` with a valid barcode, else the stored product with
        the same name key, else the id sent. Stored products that turn out to be the same one fold into it, and the
        id sent becomes an alias when it is not the canonical one. One advisory lock serializes product writes, so
        two saves of the same new product cannot make two rows (the unique gtin index is the backstop).
        """
        if conn is None:
            with self.connect() as conn:
                return self.save_product(product, conn)
        self._lock(conn)
        target, _ = self._save_identity(conn, product)
        return self.get_product(target, conn)

    @staticmethod
    def _lock(conn):
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':products'))")

    def _candidates(self, conn, product):
        """Stored rows that could be this product (same GTIN or digits, same name key, its id or alias), newest first."""
        own = self.resolve(product["id"], conn)
        gtin = normalize_gtin(product.get("barcode")) or gtin_of_id(product["id"])
        digits = barcode_digits(product.get("barcode")).lstrip("0")
        keys = sorted(name_keys(product))
        rows = conn.execute(
            "SELECT * FROM products WHERE id = %s OR id = %s OR gtin = %s "
            "OR name_key = ANY(%s) OR line_key = ANY(%s) "
            "OR (%s <> '' AND ltrim(regexp_replace(coalesce(barcode, ''), '\\D', '', 'g'), '0') = %s) "
            "ORDER BY updated_at DESC, id",
            (product["id"], own, gtin, keys, keys, digits, digits)).fetchall()
        if own:   # the own row's barcode may bring more (same GTIN under an older id)
            own_row = next((r for r in rows if r["id"] == own), None)
            own_gtin = own_row and normalize_gtin(own_row["barcode"])
            if own_gtin and own_gtin != gtin:
                rows += conn.execute("SELECT * FROM products WHERE gtin = %s", (own_gtin,)).fetchall()
        return {r["id"]: r for r in rows}, own

    def _save_identity(self, conn, product, stored=None):
        """Write one identity under its canonical id, folding the same product's other rows in. Returns
        (canonical id, ids folded into it). `stored`: the identity is that stored row itself (dedupe)."""
        rows, own = self._candidates(conn, product)
        if stored is not None:
            rows[stored["id"]] = stored
            own = stored["id"]
        target, absorb = choose(product, [self._identity(r) for r in rows.values()], own)
        if stored is not None and target != stored["id"]:
            absorb.append(stored["id"])
        absorb = [i for i in dict.fromkeys(absorb) if i in rows and i != target]
        involved = sorted((rows[i] for i in [target, *absorb] if i in rows), key=lambda r: r["updated_at"])
        merged = {}
        for row in involved:
            merged = merge_identity(merged, self._identity(row), target)
        if stored is None:
            merged = merge_identity(merged, product, target)
        if absorb:   # their GTIN moves to the target row first, so the unique index never sees it twice
            conn.execute("UPDATE products SET gtin = NULL WHERE id = ANY(%s)", (absorb,))
        self._write_product(conn, merged, max(r["updated_at"] for r in involved) if stored is not None else None)
        if absorb:
            self._fold(conn, target, absorb)
        if product["id"] != target and not conn.execute("SELECT 1 FROM products WHERE id = %s",
                                                        (product["id"],)).fetchone():
            self._alias(conn, [product["id"]], target)
        return target, absorb

    def _write_product(self, conn, product, updated_at=None):
        """Upsert the full merged identity; the identity's other keys (alternatives...) go to `extra`."""
        values = {col: product.get(key) for key, col in PRODUCT_COLUMNS.items()}
        values["brand"] = values["brand"] or ""
        values["product_name"] = values["product_name"] or ""
        values["gtin"] = normalize_gtin(product.get("barcode")) or gtin_of_id(product["id"])
        values["name_key"] = name_key(product)
        values["line_key"] = line_key(product) or None
        extra = {k: v for k, v in product.items() if k not in PRODUCT_COLUMNS}
        cols = list(values)
        conn.execute(
            f"INSERT INTO products ({', '.join(cols)}, extra, updated_at) "
            f"VALUES ({', '.join('%s' for _ in cols)}, %s, COALESCE(%s, now())) "
            f"ON CONFLICT (id) DO UPDATE SET {', '.join(f'{c} = EXCLUDED.{c}' for c in cols if c != 'id')}, "
            "extra = EXCLUDED.extra, updated_at = EXCLUDED.updated_at",
            [*values.values(), json.dumps(extra, ensure_ascii=False), updated_at])
        conn.execute("DELETE FROM product_aliases WHERE old_id = %s", (product["id"],))   # a live id is no alias

    @staticmethod
    def _alias(conn, old_ids, product_id):
        conn.execute("INSERT INTO product_aliases (old_id, product_id) SELECT unnest(%s::text[]), %s "
                     "ON CONFLICT (old_id) DO UPDATE SET product_id = EXCLUDED.product_id", (list(old_ids), product_id))

    def add_alias(self, old_id, product_id):
        """`old_id` leads to `product_id` from now on, unless `old_id` is a stored product of its own."""
        with self.connect() as conn:
            if conn.execute("SELECT 1 FROM products WHERE id = %s", (old_id,)).fetchone() is None:
                self._alias(conn, [old_id], product_id)

    def _fold(self, conn, target, losers):
        """Move everything of `losers` onto `target` and delete them; their ids become aliases of it.

        Listings keep one row per (product, page) (spec 9): when two of them listed the same page, the newest stays.
        """
        for table in ("searches", "pages", "scrape_runs"):
            conn.execute(f"UPDATE {table} SET product_id = %s WHERE product_id = ANY(%s)", (target, losers))
        conn.execute("UPDATE searches SET raw = jsonb_set(raw, '{product,id}', to_jsonb(%s::text)) "
                     "WHERE raw->'product'->>'id' = ANY(%s)", (target, losers))
        conn.execute("DELETE FROM listings l USING (SELECT id, row_number() OVER (PARTITION BY page_id "
                     "ORDER BY scraped_at DESC, id DESC) AS n FROM listings WHERE product_id = ANY(%s)) ranked "
                     "WHERE l.id = ranked.id AND ranked.n > 1", ([target, *losers],))
        conn.execute("UPDATE listings SET product_id = %s WHERE product_id = ANY(%s)", (target, losers))
        conn.execute("UPDATE product_aliases SET product_id = %s WHERE product_id = ANY(%s)", (target, losers))
        self._alias(conn, losers, target)
        conn.execute("DELETE FROM products WHERE id = ANY(%s)", (losers,))

    def resolve(self, product_id, conn=None):
        """The stored product an id names: itself, or the product it was merged into or renamed to (an alias)."""
        if conn is None:
            with self.connect() as conn:
                return self.resolve(product_id, conn)
        row = conn.execute("SELECT id, 0 AS rank FROM products WHERE id = %s UNION ALL "
                           "SELECT product_id, 1 FROM product_aliases WHERE old_id = %s ORDER BY rank LIMIT 1",
                           (product_id, product_id)).fetchone()
        return row["id"] if row else None

    def canonical_id(self, product):
        """The id a save of this identity would use, without saving (to key a search before it runs)."""
        with self.connect() as conn:
            rows, own = self._candidates(conn, product)
            return choose(product, [self._identity(r) for r in rows.values()], own)[0]

    def save_page(self, page, product_id, search_id=None, conn=None):
        """Upsert a SourcePage for a product, and its retailer by domain."""
        if conn is None:
            with self.connect() as conn:
                return self.save_page(page, product_id, search_id, conn)
        kind = page.get("sourceType") if page.get("sourceType") in ("first_party", "third_party") else "third_party"
        conn.execute("INSERT INTO retailers (domain, name, kind) VALUES (%s, %s, %s) "
                     "ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind",
                     (page["domain"], page.get("retailerName") or page["domain"], kind))
        verification, scraper, access = (page.get("verification") or {}), (page.get("scraper") or {}), (page.get("access") or {})
        extra = {k: v for k, v in page.items() if k not in PAGE_KEYS}
        if set(access) - {"status", "code", "reason"}:
            extra["access"] = {k: v for k, v in access.items() if k not in ("status", "code", "reason")}
        # The search only when Postgres has it: a page the JSON store knew first may name a search never saved here.
        conn.execute(
            """INSERT INTO pages (id, product_id, retailer_domain, search_id, url, title, match_type,
                   verification_status, verification_confidence, verification_reason,
                   access_status, access_code, access_reason, scraper_status, scraper_id, extra)
               VALUES (%s, %s, %s, (SELECT id FROM searches WHERE id = %s), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET product_id = EXCLUDED.product_id,
                   retailer_domain = EXCLUDED.retailer_domain, search_id = COALESCE(EXCLUDED.search_id, pages.search_id),
                   url = EXCLUDED.url, title = EXCLUDED.title, match_type = EXCLUDED.match_type,
                   verification_status = EXCLUDED.verification_status,
                   verification_confidence = EXCLUDED.verification_confidence,
                   verification_reason = EXCLUDED.verification_reason, access_status = EXCLUDED.access_status,
                   access_code = EXCLUDED.access_code, access_reason = EXCLUDED.access_reason,
                   scraper_status = EXCLUDED.scraper_status, scraper_id = EXCLUDED.scraper_id,
                   extra = EXCLUDED.extra, updated_at = now()""",
            (page["id"], product_id, page["domain"], search_id, page["url"], page.get("title"),
             page.get("matchType") or "exact", verification.get("status"), verification.get("confidence"),
             verification.get("reason"), access.get("status"), access.get("code"), access.get("reason"),
             scraper.get("status") or "missing", scraper.get("scraperId"), json.dumps(extra, ensure_ascii=False)))

    def refuse_site(self, domain, access):
        """Every saved page on a site that refused us: still a page of the product (it's sold there), never collected."""
        with self.connect() as conn:
            conn.execute("UPDATE pages SET access_status = %s, access_code = %s, access_reason = %s, "
                         "scraper_status = 'missing', scraper_id = NULL, updated_at = now() WHERE retailer_domain = %s",
                         (access["status"], access["code"], access["reason"], domain))

    def save_search(self, result):
        """A finished search: the product, the search itself and every page it found, in one transaction.
        Returns the product's canonical id (the search and its pages are saved under it)."""
        with self.connect() as conn:
            product_id = self.save_product(result["product"], conn)["id"]
            result = {**result, "product": {**result["product"], "id": product_id}}
            conn.execute("INSERT INTO searches (id, product_id, raw) VALUES (%s, %s, %s) "
                         "ON CONFLICT (id) DO UPDATE SET product_id = EXCLUDED.product_id, raw = EXCLUDED.raw",
                         (result["searchId"], product_id, json.dumps(result, ensure_ascii=False, default=str)))
            for page in result["pages"]:
                self.save_page(page, product_id, result["searchId"], conn)
        return product_id

    def set_scraper(self, domain, scraper):
        """A scraper became available for a host: every saved page on it says so."""
        with self.connect() as conn:
            conn.execute("UPDATE pages SET scraper_status = %s, scraper_id = %s, updated_at = now() "
                         "WHERE retailer_domain = %s", (scraper.get("status"), scraper.get("scraperId"), domain))

    def start_run(self, run_id, product, pages):
        """A scrape starts: make sure its product and pages are here (the JSON store may know them first).
        Returns the product's canonical id, which the run and its listings are saved under."""
        with self.connect() as conn:
            product_id = self.save_product(product, conn)["id"]
            for page in pages:
                self.save_page(page, product_id, page.get("searchId"), conn)
            conn.execute("INSERT INTO scrape_runs (id, product_id) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                         (run_id, product_id))
        return product_id

    def finish_run(self, run_id, product_id, status, listings=(), failures=()):
        with self.connect() as conn:
            product_id = self.resolve(product_id, conn) or product_id
            for listing in listings:
                self._save_listing(conn, listing, product_id, run_id)
            conn.execute("UPDATE scrape_runs SET status = %s, finished_at = now(), failures = %s WHERE id = %s",
                         (status, json.dumps(list(failures), ensure_ascii=False, default=str), run_id))

    def _save_listing(self, conn, listing, product_id, run_id):
        """Merge by pageId (spec 9): one row per (product, page); a re-scrape replaces it."""
        price = listing.get("price") or {}
        fields = listing.get("fields") or {}
        availability = fields.get("availability")
        if availability is None and fields.get("available") is not None:
            availability = "in_stock" if fields["available"] else "out_of_stock"
        extra = {k: v for k, v in listing.items() if k not in LISTING_KEYS}
        conn.execute(
            """INSERT INTO listings (id, page_id, product_id, scrape_run_id, url, title, price_amount, price_currency,
                   availability, image_url, fields, extra, scraped_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, now()))
               ON CONFLICT (product_id, page_id) DO UPDATE SET id = EXCLUDED.id,
                   scrape_run_id = EXCLUDED.scrape_run_id, url = EXCLUDED.url, title = EXCLUDED.title,
                   price_amount = EXCLUDED.price_amount, price_currency = EXCLUDED.price_currency,
                   availability = EXCLUDED.availability, image_url = EXCLUDED.image_url, fields = EXCLUDED.fields,
                   extra = EXCLUDED.extra, scraped_at = EXCLUDED.scraped_at""",
            (listing["id"], listing["pageId"], product_id, run_id, listing.get("url"), listing.get("title"),
             price.get("amount"), price.get("currency"), availability, listing.get("imageUrl"),
             json.dumps(fields, ensure_ascii=False), json.dumps(extra, ensure_ascii=False), listing.get("scrapedAt")))

    # --- reads -----------------------------------------------------------------------------------------------
    @staticmethod
    def _identity(row):
        """A stored row as the full ProductIdentity, phone-local photo included (for merging, never served)."""
        product = {key: row[col] for key, col in PRODUCT_COLUMNS.items()}
        return {**(row.get("extra") or {}), **_drop_none(product)}

    @staticmethod
    def _product(row):
        product = {key: row[col] for key, col in PRODUCT_COLUMNS.items()}
        return shareable({**(row.get("extra") or {}), **_drop_none(product)})

    @staticmethod
    def _page(row):
        extra = dict(row.get("extra") or {})
        access = _drop_none({"status": row["access_status"], "code": row["access_code"],
                             "reason": row["access_reason"], **extra.pop("access", {})})
        return {**extra, "id": row["id"], "url": row["url"], "domain": row["retailer_domain"],
                "retailerName": row["retailer_name"], "sourceType": row["retailer_kind"], "title": row["title"],
                "matchType": row["match_type"],
                "verification": _drop_none({"status": row["verification_status"],
                                            "confidence": row["verification_confidence"],
                                            "reason": row["verification_reason"]}),
                "scraper": _drop_none({"status": row["scraper_status"], "scraperId": row["scraper_id"]}),
                "access": access}

    @staticmethod
    def _listing(row):
        listing = {**(row.get("extra") or {}), "id": row["id"], "pageId": row["page_id"], "url": row["url"],
                   "domain": row["retailer_domain"], "retailerName": row["retailer_name"], "title": row["title"],
                   "fields": row["fields"] or {}, "scrapedAt": _iso(row["scraped_at"])}
        if row["image_url"]:
            listing["imageUrl"] = row["image_url"]
        if row["price_amount"] is not None:
            listing["price"] = {"amount": float(row["price_amount"]), "currency": row["price_currency"]}
        return listing

    def get_product(self, product_id, conn=None):
        if conn is None:
            with self.connect() as conn:
                return self.get_product(product_id, conn)
        """The stored identity an id names (directly, or through an alias left by a merge or a rename)."""
        row = conn.execute("SELECT * FROM products WHERE id = %s", (product_id,)).fetchone() or conn.execute(
            "SELECT p.* FROM product_aliases a JOIN products p ON p.id = a.product_id WHERE a.old_id = %s",
            (product_id,)).fetchone()
        return self._product(row) if row else None

    def list_products(self, q=None, barcode=None, limit=50, offset=0):
        where, args = [], []
        if q:
            where.append("(brand ILIKE %s OR product_name ILIKE %s)")
            args += [f"%{q}%", f"%{q}%"]
        if barcode:   # by GTIN-14 when valid; else as digits, as the app and the sites disagree on leading zeros
            where.append("(gtin = %s OR ltrim(regexp_replace(coalesce(barcode, ''), '\\D', '', 'g'), '0') = %s)")
            args += [normalize_gtin(barcode), barcode_digits(barcode).lstrip("0") or None]
        sql = "SELECT * FROM products" + (f" WHERE {' AND '.join(where)}" if where else "")
        with self.connect() as conn:
            total = conn.execute(sql.replace("SELECT *", "SELECT count(*) AS n", 1), args).fetchone()["n"]
            rows = conn.execute(sql + " ORDER BY updated_at DESC, id LIMIT %s OFFSET %s", [*args, limit, offset])
            return {"products": [self._product(r) for r in rows], "total": total, "limit": limit, "offset": offset}

    def pages_for(self, product_id, conn):
        rows = conn.execute("SELECT p.*, r.name AS retailer_name, r.kind AS retailer_kind FROM pages p "
                            "JOIN retailers r ON r.domain = p.retailer_domain WHERE p.product_id = %s "
                            "ORDER BY p.created_at, p.id", (product_id,))
        return [self._page(r) for r in rows]

    def latest_listings(self, product_id, conn):
        """The listing of each page (one per page: a re-scrape replaces it), newest first."""
        rows = conn.execute("SELECT l.*, p.retailer_domain, r.name AS retailer_name "
                            "FROM listings l JOIN pages p ON p.id = l.page_id "
                            "JOIN retailers r ON r.domain = p.retailer_domain WHERE l.product_id = %s",
                            (product_id,))
        return sorted((self._listing(r) for r in rows), key=lambda l: l["scrapedAt"], reverse=True)

    def product_listings(self, product_id):
        """`GET /products/:id/listings`: {product, listings}, or None for an unknown product."""
        with self.connect() as conn:
            product = self.get_product(product_id, conn)
            if product is None:
                return None
            product_id = product["id"]   # an old id answers with the product it was merged into
            listings = self.latest_listings(product_id, conn)
            failures = self.open_failures(product_id, {l["pageId"] for l in listings}, conn)
            return {"product": product, "listings": listings, **({"failures": failures} if failures else {})}

    def open_failures(self, product_id, listed, conn):
        """Pages of this product whose latest scrape failed and that have no listing since (same shape as a run's)."""
        rows = conn.execute("SELECT started_at, failures FROM scrape_runs WHERE product_id = %s "
                            "ORDER BY started_at DESC LIMIT 50", (product_id,)).fetchall()
        latest = {r["page_id"]: r["scraped_at"] for r in conn.execute(
            "SELECT page_id, scraped_at FROM listings WHERE product_id = %s", (product_id,))}
        out, seen = [], set()
        for run in rows:
            for failure in run["failures"] or []:
                page_id = failure.get("pageId")
                if not page_id or page_id in seen or not failure.get("url"):
                    continue
                seen.add(page_id)
                scraped = latest.get(page_id)
                if scraped is None or scraped < run["started_at"]:
                    out.append(failure)
        # Stores verified to sell it that refuse collection, never scraped: one per store, so the product still names them.
        stores = {domain_of(f["url"]) for f in out}
        for row in conn.execute("SELECT p.id, p.url, p.retailer_domain, p.access_code, p.access_reason, r.name "
                                "FROM pages p JOIN retailers r ON r.domain = p.retailer_domain "
                                "WHERE p.product_id = %s AND p.access_status = 'refused' "
                                "AND p.verification_status = 'verified' ORDER BY p.created_at, p.id",
                                (product_id,)):
            if row["id"] in seen or row["id"] in listed or row["retailer_domain"] in stores:
                continue
            stores.add(row["retailer_domain"])
            out.append({"pageId": row["id"], "url": row["url"], "code": row["access_code"] or "blocked",
                        "error": row["access_reason"] or "The site refuses automated collection",
                        "retailerName": row["name"]})
        return out

    def product_detail(self, product_id):
        """`GET /products/:id`: the product, its pages and the latest listing of each page."""
        with self.connect() as conn:
            product = self.get_product(product_id, conn)
            if product is None:
                return None
            return {"product": product, "pages": self.pages_for(product["id"], conn),
                    "listings": self.latest_listings(product["id"], conn)}

    def scans(self, limit=50):
        """`GET /scans`: products searched or scraped, the latest of either first. A product searched but never scraped
        (every store blocked, or not scraped yet) is still a recent scan, with no `lastScrapedAt` and 0 listings."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT p.*, s.last_scraped_at, coalesce(s.listing_count, 0) AS listing_count FROM products p "
                "LEFT JOIN (SELECT product_id, max(scraped_at) AS last_scraped_at, count(DISTINCT page_id) AS listing_count"
                "  FROM listings GROUP BY product_id) s ON s.product_id = p.id "
                "LEFT JOIN (SELECT product_id, max(created_at) AS last_searched_at FROM searches GROUP BY product_id) q "
                "  ON q.product_id = p.id "
                "WHERE s.product_id IS NOT NULL OR q.product_id IS NOT NULL "
                "ORDER BY greatest(s.last_scraped_at, q.last_searched_at) DESC, p.id LIMIT %s", (limit,))
            return [{"product": self._product(r), "listingCount": r["listing_count"],
                     **({"lastScrapedAt": _iso(r["last_scraped_at"])} if r["last_scraped_at"] else {})} for r in rows]

    # --- builds ----------------------------------------------------------------------------------------------
    def record_build(self, run, events=(), first_seq=0, gates=None):
        """Write one build as it stands: its row, every attempt (with the gate's report on it, from `gates` by
        attempt number) and the events numbered `first_seq` on. `run` is the AgentRun view. Idempotent, so the
        builder calls it on every event and an import can call it again."""
        gates = gates or {}
        with self.connect() as conn:
            conn.execute(
                """INSERT INTO builds (id, domain, url, kind, provider, product_id, page_id, state, stage, note, source,
                       session_url, pr_url, branch, attempt, max_attempts, access, cost, started_at, ended_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO UPDATE SET product_id = EXCLUDED.product_id, page_id = EXCLUDED.page_id,
                       state = EXCLUDED.state, stage = EXCLUDED.stage, note = EXCLUDED.note, source = EXCLUDED.source,
                       session_url = EXCLUDED.session_url, pr_url = EXCLUDED.pr_url, branch = EXCLUDED.branch,
                       attempt = EXCLUDED.attempt, access = EXCLUDED.access, cost = EXCLUDED.cost,
                       ended_at = EXCLUDED.ended_at, updated_at = now()""",
                (run["buildId"], run["domain"], run["url"], run.get("kind") or "third_party", run["provider"],
                 run.get("productId"), run.get("pageId"), run["state"], run.get("stage"), run.get("note"),
                 run.get("source"), run.get("sessionUrl"), run.get("prUrl"), run.get("branch"), run.get("attempt") or 0,
                 run.get("maxAttempts") or 0, json.dumps(run.get("access"), ensure_ascii=False),
                 json.dumps(run.get("cost") or {}), run["startedAt"], run.get("endedAt")))
            for a in run.get("attempts") or []:
                gate = gates.get(a["n"])
                conn.execute(
                    """INSERT INTO build_attempts (build_id, n, started_at, ended_at, outcome, verdict, passed, total,
                           failed, sent_back, notes, gate)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (build_id, n) DO UPDATE SET ended_at = EXCLUDED.ended_at, outcome = EXCLUDED.outcome,
                           verdict = EXCLUDED.verdict, passed = EXCLUDED.passed, total = EXCLUDED.total,
                           failed = EXCLUDED.failed, sent_back = EXCLUDED.sent_back, notes = EXCLUDED.notes,
                           gate = COALESCE(EXCLUDED.gate, build_attempts.gate)""",
                    (run["buildId"], a["n"], a["startedAt"], a.get("endedAt"), a.get("outcome"), a.get("verdict"),
                     a.get("passed") or 0, a.get("total") or 0, json.dumps(a.get("failed") or [], ensure_ascii=False),
                     bool(a.get("sentBack")), a.get("notes"),
                     json.dumps(gate, ensure_ascii=False, default=str) if gate else None))
            for seq, event in enumerate(events, first_seq):
                extra = {k: v for k, v in event.items() if k not in EVENT_KEYS}
                conn.execute(
                    "INSERT INTO build_events (build_id, seq, at, kind, stage, message, attempt, extra) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (build_id, seq) DO NOTHING",
                    (run["buildId"], seq, event["at"], event["kind"], event.get("stage"), event["message"],
                     event.get("attempt") or 0, json.dumps(extra, ensure_ascii=False, default=str)))

    @staticmethod
    def _build(row, attempts=(), events=()):
        return {"buildId": row["id"], "provider": row["provider"], "url": row["url"], "domain": row["domain"],
                "kind": row["kind"], "state": row["state"], "stage": row["stage"], "note": row["note"],
                "source": row["source"], "sessionUrl": row["session_url"], "prUrl": row["pr_url"],
                "branch": row["branch"], "access": row["access"], "attempt": row["attempt"],
                "maxAttempts": row["max_attempts"], "attempts": list(attempts), "events": list(events),
                "cost": row["cost"] or {}, "startedAt": _iso(row["started_at"]), "endedAt": _iso(row["ended_at"]),
                "productId": row["product_id"], "pageId": row["page_id"]}

    @staticmethod
    def _attempt(row):
        return {"n": row["n"], "startedAt": _iso(row["started_at"]), "endedAt": _iso(row["ended_at"]),
                "outcome": row["outcome"], "verdict": row["verdict"], "passed": row["passed"], "total": row["total"],
                "failed": row["failed"] or [], "sentBack": row["sent_back"], "notes": row["notes"]}

    @staticmethod
    def _event(row):
        return {**(row["extra"] or {}), "at": _iso(row["at"]), "kind": row["kind"], "stage": row["stage"],
                "message": row["message"], "attempt": row["attempt"]}

    def build_rows(self):
        """Every build, newest first, without attempts or events: enough for the per-site tally."""
        with self.connect() as conn:
            rows = conn.execute("SELECT id, domain, state, source, started_at FROM builds ORDER BY started_at DESC")
            return [{"buildId": r["id"], "domain": r["domain"], "state": r["state"], "source": r["source"],
                     "startedAt": _iso(r["started_at"])} for r in rows]

    def list_builds(self, domain=None, state=None, limit=50, events=5):
        """Builds newest first, each with its attempts and its last `events` events."""
        where, args = [], []
        if domain:
            where.append("domain = %s")
            args.append(domain)
        if state:
            where.append("state = %s")
            args.append(state)
        sql = "SELECT * FROM builds" + (f" WHERE {' AND '.join(where)}" if where else "")
        with self.connect() as conn:
            rows = conn.execute(sql + " ORDER BY started_at DESC LIMIT %s", [*args, limit]).fetchall()
            ids = [r["id"] for r in rows]
            attempts, latest = {}, {}
            for r in conn.execute("SELECT * FROM build_attempts WHERE build_id = ANY(%s) ORDER BY n", (ids,)):
                attempts.setdefault(r["build_id"], []).append(self._attempt(r))
            for r in conn.execute("SELECT * FROM (SELECT e.*, row_number() OVER (PARTITION BY build_id ORDER BY seq DESC)"
                                  " AS k FROM build_events e WHERE build_id = ANY(%s)) x WHERE k <= %s ORDER BY seq",
                                  (ids, events)):
                latest.setdefault(r["build_id"], []).append(self._event(r))
            return [self._build(r, attempts.get(r["id"], []), latest.get(r["id"], [])) for r in rows]

    def get_build(self, build_id):
        """One build's whole recording: every event, every attempt, and `gates` (the gate's report on each attempt,
        or None where an attempt never reached the gate)."""
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM builds WHERE id = %s", (build_id,)).fetchone()
            if row is None:
                return None
            attempts = conn.execute("SELECT * FROM build_attempts WHERE build_id = %s ORDER BY n", (build_id,)).fetchall()
            events = conn.execute("SELECT * FROM build_events WHERE build_id = %s ORDER BY seq", (build_id,)).fetchall()
            return {**self._build(row, [self._attempt(a) for a in attempts], [self._event(e) for e in events]),
                    "gates": [a["gate"] for a in attempts]}

    def import_builds(self, folder):
        """Builds a JSON store recorded under `folder` (DATA_DIR) that are not here yet. Returns how many."""
        from .store import Store
        store, known = Store(folder), {r["buildId"] for r in self.build_rows()}
        added = 0
        for run in store.all("builds"):
            if run.get("buildId") and run["buildId"] not in known:
                if run.get("endedAt") and run.get("state") in ("queued", "running", "building", "fixing"):
                    # An older backend left a build that hit its own error at the state it was in.
                    run = {**run, "state": "failed",
                           "note": f"Ended while {run['state']}, without a final state: {run.get('note') or ''}"[:300]}
                gates = {a["n"]: gate_record(store.get("gates", f"{run['buildId']}-{a['n']}"))
                         for a in run.get("attempts") or []}
                self.record_build(run, run.get("events") or [], 0, {n: g for n, g in gates.items() if g})
                added += 1
        return added


EVENT_KEYS = {"at", "kind", "stage", "message", "attempt"}


def gate_record(report):
    """What a gate report keeps in the database and serves: no staging paths from this machine."""
    if not report:
        return None
    kept = {"source": report.get("source"), "verdict": report.get("verdict"),
            "checks": [{"name": c.get("name"), "passed": bool(c.get("passed")), "detail": str(c.get("detail") or "")}
                       for c in report.get("checks") or []]}
    return {**kept, "rows": report["rows"]} if isinstance(report.get("rows"), int) else kept


def main(argv):
    import os
    url = os.environ.get("DATABASE_URL")
    if not url or not (argv[:1] == ["migrate"] or (argv[:1] == ["import-builds"] and argv[1:])):
        sys.exit("usage: DATABASE_URL=postgresql://... uv run python -m server.db migrate\n"
                 "       DATABASE_URL=postgresql://... uv run python -m server.db import-builds DATA_DIR [DATA_DIR ...]")
    database = Database(url)
    if argv[0] == "import-builds":
        database.migrate()
        for folder in argv[1:]:
            print(f"{folder}: {database.import_builds(Path(folder))} builds added")
        return
    applied = database.migrate()
    print(f"applied {', '.join(applied)}" if applied else "up to date")
    for old, new in database.moved.items():
        print(f"product {old} -> {new}")


if __name__ == "__main__":
    main(sys.argv[1:])
