"""Postgres: the repository and the endpoints on it, against a real server when TEST_DATABASE_URL is set.

Each test gets its own throwaway schema (migrated from Drizzle's SQL in db/drizzle), dropped afterwards. The last tests run the
product endpoints on the JSON store, with no database at all.
"""
import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

import pytest

from server.app import ApiError, handler_for
from server.db import Database
from tests.conftest import PAGE, TAKIS, make_service, wait, write_source

URL = os.environ.get("TEST_DATABASE_URL")
needs_pg = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run the Postgres tests")

DORITOS = {"id": "doritos-incognita-62g", "brand": "Doritos", "productName": "Doritos Incógnita", "variant": "Incógnita",
           "size": "62 g", "barcode": "7500000000017", "manufacturer": "Sabritas (PepsiCo México)",
           "categoryGuess": "Botanas > Totopos", "imageSource": "openfoodfacts", "confidence": 0.95,
           "source": "claude", "alternatives": [{"brand": "Doritos", "productName": "Doritos Nacho", "confidence": 0.31}]}


@pytest.fixture
def db():
    schema = f"test_{uuid.uuid4().hex[:12]}"
    database = Database(URL, schema=schema)
    with database.connect() as conn:
        conn.execute(f"CREATE SCHEMA {schema}")
    database.migrate()
    try:
        yield database
    finally:
        with database.connect() as conn:
            conn.execute(f"DROP SCHEMA {schema} CASCADE")


def rows(db, sql, *args):
    with db.connect() as conn:
        return conn.execute(sql, args).fetchall()


def db_service(tmp_path, kit_copy, db, steps=()):
    service, runner = make_service(tmp_path, kit_copy, list(steps))
    service.db = service.builds.db = db
    return service, runner


@needs_pg
def test_migrations_apply_once(db):
    assert db.migrate() == []
    assert [r["name"] for r in rows(db, "SELECT name FROM schema_migrations ORDER BY name")] == [
        "0000_init", "0001_listings_merge_by_page", "0002_products_by_gtin",
        "0003_products_line_key", "0004_builds"]
    tables = {r["table_name"] for r in rows(db, "SELECT table_name FROM information_schema.tables "
                                                "WHERE table_schema = current_schema()")}
    assert tables == {"schema_migrations", "products", "retailers", "searches", "pages", "scrape_runs", "listings",
                      "product_aliases", "builds", "build_attempts", "build_events"}


def test_drizzle_statements_are_split_and_unqualified():
    statements = Database.statements(Database("unused").journal()[0][1])
    assert len(statements) > 6 and all("statement-breakpoint" not in s for s in statements)
    assert not any('"public".' in s for s in statements)
    assert any(s.startswith('CREATE TABLE "products"') for s in statements)


@needs_pg
def test_pre_drizzle_database_is_baselined_not_rebuilt(db):
    # A database made from the old hand-written 001_init.sql: same tables, recorded under the old name, with rows.
    db.save_product(DORITOS)
    with db.connect() as conn:
        conn.execute("DELETE FROM schema_migrations")
        conn.execute("INSERT INTO schema_migrations (name) VALUES ('001_init.sql')")
    with db.connect() as conn:   # and the old schema's non-unique listings index, as before 0001
        conn.execute("DROP INDEX listings_product_page_key")
        conn.execute("CREATE INDEX listings_product_page_idx ON listings (product_id, page_id, scraped_at DESC)")
        conn.execute("DROP TABLE product_aliases")   # and none of 0002, 0003 or 0004 yet
        conn.execute("ALTER TABLE products DROP COLUMN gtin, DROP COLUMN name_key, DROP COLUMN line_key")
        conn.execute("DROP TABLE build_events, build_attempts, builds")
    assert db.migrate() == ["0000_init", "0001_listings_merge_by_page", "0002_products_by_gtin",
        "0003_products_line_key", "0004_builds"]
    assert {r["name"] for r in rows(db, "SELECT name FROM schema_migrations")} == {
        "001_init.sql", "0000_init", "0001_listings_merge_by_page", "0002_products_by_gtin",
        "0003_products_line_key", "0004_builds"}
    assert db.get_product(DORITOS["id"])["productName"] == DORITOS["productName"]
    assert db.migrate() == []


@needs_pg
def test_merge_migration_keeps_the_newest_listing_per_page(db):
    # A database from before 0001: duplicate listings per (product, page) as history. The migration keeps the newest.
    db.save_product(TAKIS)
    page = {"id": "pg-1", "url": "https://shop.example/p", "domain": "shop.example", "retailerName": "Shop",
            "sourceType": "third_party", "title": "Takis"}
    db.save_page(page, TAKIS["id"])
    with db.connect() as conn:
        conn.execute("DROP INDEX listings_product_page_key")
        conn.execute("CREATE INDEX listings_product_page_idx ON listings (product_id, page_id, scraped_at DESC)")
        conn.execute("DELETE FROM schema_migrations WHERE name = '0001_listings_merge_by_page'")
        for n, at in ((1, "2026-10-28T10:00:00Z"), (2, "2026-10-29T10:00:00Z"), (3, "2026-10-27T10:00:00Z")):
            conn.execute("INSERT INTO listings (id, page_id, product_id, title, scraped_at) VALUES (%s, 'pg-1', %s, %s, %s)",
                         (f"l{n}", TAKIS["id"], f"run {n}", at))
    assert db.migrate() == ["0001_listings_merge_by_page"]
    assert [r["id"] for r in rows(db, "SELECT id FROM listings")] == ["l2"]
    with db.connect() as conn:   # and from now on a second listing for the page is an upsert
        db._save_listing(conn, {"id": "l4", "pageId": "pg-1", "title": "run 4", "scrapedAt": "2026-10-30T10:00:00Z"},
                         TAKIS["id"], None)
    assert [(r["id"], r["title"]) for r in rows(db, "SELECT id, title FROM listings")] == [("l4", "run 4")]


@needs_pg
def test_a_product_round_trips_and_is_found_by_name_or_barcode(db):
    assert db.save_product(DORITOS) == DORITOS
    assert db.save_product({**DORITOS, "size": "75 g"})["size"] == "75 g"   # an upsert, not a second row
    db.save_product(TAKIS)
    assert db.list_products()["total"] == 2
    assert [p["id"] for p in db.list_products(q="incóg")["products"]] == [DORITOS["id"]]
    assert [p["id"] for p in db.list_products(q="TAKIS")["products"]] == [TAKIS["id"]]
    assert [p["id"] for p in db.list_products(barcode="750103042453")["products"]] == [TAKIS["id"]]   # leading 0
    page = db.list_products(limit=1, offset=1)
    assert len(page["products"]) == 1 and page["total"] == 2
    assert db.get_product("nope") is None


@needs_pg
def test_search_build_and_scrape_land_in_postgres(tmp_path, kit_copy, db):
    service, _ = db_service(tmp_path, kit_copy, db, [lambda w, m: write_source(w)])
    job = service.post_search({"product": TAKIS, "scanType": "both", "includeSimilar": False, "region": "MX"})[1]
    pages = wait(service, job["jobId"])["result"]["pages"]
    assert db.get_product(TAKIS["id"]) == TAKIS
    saved = {p["id"]: p for p in service.get_product(TAKIS["id"])[1]["pages"]}
    assert saved == {p["id"]: p for p in pages}    # SourcePage shapes come back as the search returned them
    assert {r["domain"] for r in rows(db, "SELECT domain FROM retailers")} == {"shop.example", "amazon.com.mx",
                                                                             "other.example"}
    assert rows(db, "SELECT count(*) AS n FROM searches")[0]["n"] == 1
    # Searched, not scraped yet: already a recent scan (the app says "never scraped").
    (scan,) = service.get_scans()[1]["scans"]
    assert scan["product"]["id"] == TAKIS["id"] and scan["listingCount"] == 0 and "lastScrapedAt" not in scan

    shop = next(p for p in pages if p["domain"] == "shop.example")
    wait(service, service.post_build({"url": shop["url"], "pageId": shop["id"]})[1]["jobId"])
    (row,) = rows(db, "SELECT scraper_status, scraper_id FROM pages WHERE id = %s", shop["id"])
    assert row == {"scraper_status": "available", "scraper_id": "shop_mx"}

    ids = [p["id"] for p in pages if p["domain"] in ("shop.example", "amazon.com.mx")]
    for _ in range(2):   # scrape twice: merge by pageId, the second replaces the first
        view = wait(service, service.post_scrape({"searchId": "s", "productId": TAKIS["id"], "pageIds": ids})[1]["jobId"])
        assert view["status"] == "succeeded"
    (listing,) = view["result"]["listings"]
    runs = rows(db, "SELECT status, failures FROM scrape_runs ORDER BY started_at")
    assert [r["status"] for r in runs] == ["succeeded", "succeeded"] and runs[-1]["failures"][0]["code"] == "ai_opt_out"
    assert rows(db, "SELECT count(*) AS n FROM listings")[0]["n"] == 1
    (stored,) = rows(db, "SELECT price_amount, price_currency, availability FROM listings WHERE id = %s", listing["id"])
    assert (float(stored["price_amount"]), stored["price_currency"], stored["availability"]) == (18.5, "MXN", "in_stock")

    served = service.get_listings(TAKIS["id"])[1]
    assert served["product"] == TAKIS and served["listings"] == [listing]
    assert [f["code"] for f in served["failures"]] == ["ai_opt_out"]   # the refused page, no listing since
    (scan,) = service.get_scans()[1]["scans"]
    assert scan["product"] == TAKIS and scan["listingCount"] == 1 and scan["lastScrapedAt"] == listing["scrapedAt"]
    assert service.get_product(TAKIS["id"])[1]["listings"] == [listing]
    with pytest.raises(ApiError):
        service.get_listings("nope")


@needs_pg
def test_product_endpoints_over_http(tmp_path, kit_copy, db):
    service, _ = db_service(tmp_path, kit_copy, db)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(service))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(base + path, data=data, method="GET" if body is None else "POST",
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    try:
        assert call("/products", DORITOS) == (200, {"product": DORITOS})
        assert call("/products", {"product": TAKIS})[0] == 200
        status, found = call("/products?q=doritos")
        assert status == 200 and found["products"] == [DORITOS] and found["total"] == 1
        assert call("/products?barcode=0750103042453")[1]["products"] == [TAKIS]
        assert call("/products?limit=1")[1]["limit"] == 1
        assert call(f"/products/{DORITOS['id']}") == (200, {"product": DORITOS, "pages": [], "listings": []})
        assert call("/products/nope")[1]["code"] == "not_found"
        assert call("/products", {"brand": "No id"})[1]["code"] == "invalid_request"
        assert call("/products?limit=lots")[0] == 400
        assert call(f"/products/{DORITOS['id']}/listings") == (200, {"product": DORITOS, "listings": []})
    finally:
        server.shutdown()


def test_product_endpoints_work_on_the_json_store_too(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    assert service.db is None
    assert service.post_product({"product": DORITOS}) == (200, {"product": DORITOS})
    service.post_product(TAKIS)
    assert service.get_products({"q": "takis"})[1]["products"] == [TAKIS]
    assert service.get_products({"barcode": "750103042453"})[1]["total"] == 1
    assert service.get_product(DORITOS["id"])[1] == {"product": DORITOS, "pages": [], "listings": []}
    with pytest.raises(ApiError):
        service.get_product("nope")


# --- one product, one id (server/products.py) -------------------------------------------------------------------
CHOKLAD_PHOTO = {"id": "choklad-not-100-g", "brand": "IKEA", "productName": "CHOKLAD NÖT", "size": "100 g",
                 "imageUrl": "https://img.example/choklad.jpg", "imageSource": "openfoodfacts", "source": "claude"}
CHOKLAD_SCAN = {"id": "ikea-choklad-not-100-g", "brand": "IKEA", "productName": "IKEA CHOKLAD NÖT", "size": "100 g",
                "barcode": "7315122013887", "source": "claude"}
CANON = "gtin-07315122013887"


def page_for(n, domain="shop.example"):
    return {"id": f"pg-{n}", "url": f"https://{domain}/p/{n}", "domain": domain, "retailerName": domain,
            "sourceType": "third_party", "title": f"page {n}"}


@needs_pg
def test_a_barcode_is_the_key_whatever_the_name(db):
    first = db.save_product(CHOKLAD_SCAN)
    assert first["id"] == CANON and first["barcode"] == "7315122013887"
    again = db.save_product({"id": "chocolate-avellana", "brand": "Ikea", "productName": "Chocolate con avellanas",
                             "barcode": "007315122013887"})
    assert again["id"] == CANON and again["productName"] == "Chocolate con avellanas"   # latest name wins
    assert [r["id"] for r in rows(db, "SELECT id FROM products")] == [CANON]
    assert db.get_product("chocolate-avellana")["id"] == CANON   # the id sent is an alias now
    assert db.get_product("ikea-choklad-not-100-g")["id"] == CANON
    # a photo scan of the same name (no barcode) is the same product, and never drops the barcode
    photo = db.save_product({**CHOKLAD_PHOTO, "productName": "Chocolate con avellanas", "brand": "IKEA"})
    assert photo["id"] == CANON and photo["barcode"] == "007315122013887" and photo["imageUrl"]
    # a wrong check number is kept as given and is a different product
    other = db.save_product({**CHOKLAD_SCAN, "id": "bad-check", "barcode": "7315122013886"})
    assert other["id"] == "bad-check" and other["barcode"] == "7315122013886"
    assert db.list_products(barcode="07315122013887")["total"] == 1


@needs_pg
def test_a_barcode_scan_folds_in_the_earlier_photo_scan(db):
    db.save_product(CHOKLAD_PHOTO)
    db.save_page(page_for(1), CHOKLAD_PHOTO["id"])
    saved = db.save_product(CHOKLAD_SCAN)
    assert saved["id"] == CANON and saved["imageUrl"] == CHOKLAD_PHOTO["imageUrl"]   # the photo's fields stay
    assert [r["id"] for r in rows(db, "SELECT id FROM products")] == [CANON]
    assert [r["product_id"] for r in rows(db, "SELECT product_id FROM pages")] == [CANON]
    assert db.product_detail(CHOKLAD_PHOTO["id"])["product"]["id"] == CANON


@needs_pg
def test_save_search_answers_with_the_canonical_id(db):
    db.save_product(CHOKLAD_PHOTO)
    product_id = db.save_search({"searchId": "s1", "product": CHOKLAD_SCAN, "pages": [page_for(1), page_for(2)]})
    assert product_id == CANON
    (search,) = rows(db, "SELECT product_id, raw FROM searches")
    assert search["product_id"] == CANON and search["raw"]["product"]["id"] == CANON
    assert {r["product_id"] for r in rows(db, "SELECT product_id FROM pages")} == {CANON}
    db.start_run("r1", {"id": CHOKLAD_PHOTO["id"]}, [])   # an old id: the run lands on the product
    assert rows(db, "SELECT product_id FROM scrape_runs")[0]["product_id"] == CANON


@needs_pg
def test_a_scrape_of_a_page_from_a_search_postgres_never_saw_still_starts(db):
    # The JSON store had the search before Postgres was turned on (once a ForeignKeyViolation).
    db.save_search({"searchId": "s1", "product": CHOKLAD_SCAN, "pages": [page_for(1)]})
    db.start_run("r1", {"id": CANON}, [{**page_for(1), "searchId": "s1"}, {**page_for(2), "searchId": "s-store-only"}])
    assert {r["id"]: r["search_id"] for r in rows(db, "SELECT id, search_id FROM pages")} == {
        page_for(1)["id"]: "s1", page_for(2)["id"]: None}
    assert rows(db, "SELECT product_id FROM scrape_runs")[0]["product_id"] == CANON


@needs_pg
def test_the_endpoints_return_the_canonical_id(tmp_path, kit_copy, db):
    service, _ = db_service(tmp_path, kit_copy, db)
    status, out = service.post_product(CHOKLAD_SCAN)
    assert status == 200 and out["product"]["id"] == CANON
    assert service.store.get("products", CANON)["barcode"] == "7315122013887"
    assert service.get_product("ikea-choklad-not-100-g")[1]["product"]["id"] == CANON
    assert service.get_listings("ikea-choklad-not-100-g")[1]["product"]["id"] == CANON
    db.save_product(TAKIS)
    takis = {**TAKIS, "id": "takis-otra-vez"}   # same (invalid) barcode, another slug: still one product
    job = service.post_search({"product": takis, "scanType": "both", "includeSimilar": False, "region": "MX"})[1]
    view = wait(service, job["jobId"])
    assert view["result"]["product"]["id"] == "takis-otra-vez"   # the id the app sent (the contract)...
    assert db.resolve("takis-otra-vez") == TAKIS["id"]           # ...which now leads to the one stored product
    assert db.list_products(q="takis")["total"] == 1


@needs_pg
def test_a_scrape_under_the_sent_id_lands_on_the_canonical_product(tmp_path, kit_copy, db):
    """The app keeps the id it sent; a scrape under it must not create a blank product (seen in the checker)."""
    service, _ = db_service(tmp_path, kit_copy, db, [lambda w, m: write_source(w)])
    recorded = json.loads((service.search.fixtures / "takis.json").read_text(encoding="utf-8"))
    recorded["match"] = {"barcodes": ["7501030424536"], "names": []}
    (service.search.fixtures / "takis-real.json").write_text(json.dumps(recorded), encoding="utf-8")
    sent = {**TAKIS, "id": "takis-fuego-56g", "barcode": "7501030424536"}   # a real EAN: canonical id differs
    job = service.post_search({"product": sent, "scanType": "both", "includeSimilar": False, "region": "MX"})[1]
    view = wait(service, job["jobId"])
    assert view["status"] == "succeeded" and view["result"]["product"]["id"] == "takis-fuego-56g"
    pages = view["result"]["pages"]
    shop = next(p for p in pages if p["domain"] == "shop.example")
    wait(service, service.post_build({"url": shop["url"], "pageId": shop["id"]})[1]["jobId"])
    view = wait(service, service.post_scrape({"searchId": "s", "productId": "takis-fuego-56g",
                                              "pageIds": [shop["id"]]})[1]["jobId"])
    assert view["status"] == "succeeded" and len(view["result"]["listings"]) == 1
    assert [r["id"] for r in rows(db, "SELECT id FROM products")] == ["gtin-07501030424536"]
    (scan,) = service.get_scans()[1]["scans"]
    assert scan["product"]["id"] == "gtin-07501030424536" and scan["product"]["brand"] == "Takis"
    served = service.get_listings("takis-fuego-56g")[1]
    assert served["product"]["productName"] == "Takis Fuego" and len(served["listings"]) == 1


def seed_old_rows(db):
    """The live database before 0002: two rows for CHOKLAD (one with the barcode, one from a photo), each with
    pages, a listing on a shared page, a search and a scrape run; plus an unrelated product."""
    with db.connect() as conn:
        for p, at in ((CHOKLAD_PHOTO, "2026-10-29T08:46:00Z"), (CHOKLAD_SCAN, "2026-10-29T09:41:00Z"),
                      (DORITOS, "2026-10-29T08:43:00Z")):
            conn.execute("INSERT INTO products (id, brand, product_name, size, barcode, image_url, updated_at) "
                         "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                         (p["id"], p["brand"], p["productName"], p.get("size"), p.get("barcode"), p.get("imageUrl"), at))
        conn.execute("INSERT INTO retailers (domain, name) VALUES ('shop.example', 'Shop')")
        for pid, n in ((CHOKLAD_SCAN["id"], 1), (CHOKLAD_SCAN["id"], 2), (CHOKLAD_PHOTO["id"], 3), (DORITOS["id"], 4)):
            conn.execute("INSERT INTO pages (id, product_id, retailer_domain, url) VALUES (%s, %s, 'shop.example', %s)",
                         (f"pg-{n}", pid, f"https://shop.example/p/{n}"))
        for pid, sid in ((CHOKLAD_SCAN["id"], "s-scan"), (CHOKLAD_PHOTO["id"], "s-photo")):
            conn.execute("INSERT INTO searches (id, product_id, raw) VALUES (%s, %s, %s)",
                         (sid, pid, json.dumps({"product": {"id": pid}})))
            conn.execute("INSERT INTO scrape_runs (id, product_id) VALUES (%s, %s)", (f"r-{sid}", pid))
        # both rows listed page pg-1 (a page moves to the latest search's product): the newest listing stays
        for lid, pid, page, at in (("l-old", CHOKLAD_PHOTO["id"], "pg-1", "2026-10-28T10:00:00Z"),
                                   ("l-new", CHOKLAD_SCAN["id"], "pg-1", "2026-10-29T10:00:00Z"),
                                   ("l-3", CHOKLAD_PHOTO["id"], "pg-3", "2026-10-27T10:00:00Z")):
            conn.execute("INSERT INTO listings (id, page_id, product_id, scraped_at) VALUES (%s, %s, %s, %s)",
                         (lid, page, pid, at))


@needs_pg
def test_the_migration_merges_duplicates_and_keeps_old_ids_working(db):
    with db.connect() as conn:   # back to before 0002
        conn.execute("DROP TABLE product_aliases")
        conn.execute("ALTER TABLE products DROP COLUMN gtin, DROP COLUMN name_key")
        conn.execute("DELETE FROM schema_migrations WHERE name = '0002_products_by_gtin'")
    seed_old_rows(db)
    assert db.migrate() == ["0002_products_by_gtin"]
    assert db.moved == {"choklad-not-100-g": CANON, "ikea-choklad-not-100-g": CANON}
    products = rows(db, "SELECT id, product_name, barcode, gtin, name_key, image_url FROM products ORDER BY id")
    assert products == [
        {"id": DORITOS["id"], "product_name": DORITOS["productName"], "barcode": DORITOS["barcode"], "gtin": None,
         "name_key": "doritos incognita 62g", "image_url": None},
        {"id": CANON, "product_name": "IKEA CHOKLAD NÖT", "barcode": "7315122013887", "gtin": "07315122013887",
         "name_key": "ikea choklad not 100g", "image_url": CHOKLAD_PHOTO["imageUrl"]}]
    assert {r["id"]: r["product_id"] for r in rows(db, "SELECT id, product_id FROM pages")} == {
        "pg-1": CANON, "pg-2": CANON, "pg-3": CANON, "pg-4": DORITOS["id"]}
    assert {r["product_id"] for r in rows(
        db, "SELECT product_id FROM searches UNION SELECT product_id FROM scrape_runs")} == {CANON}
    assert sorted(r["id"] for r in rows(db, "SELECT id FROM listings")) == ["l-3", "l-new"]
    assert {r["raw"]["product"]["id"] for r in rows(db, "SELECT raw FROM searches")} == {CANON}
    detail = db.product_detail("choklad-not-100-g")
    assert detail["product"]["id"] == CANON and len(detail["pages"]) == 3 and len(detail["listings"]) == 2
    assert db.product_listings("ikea-choklad-not-100-g")["product"]["id"] == CANON
    assert db.migrate() == [] and db.moved == {}   # and it is idempotent


def test_the_json_store_keys_products_the_same_way(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    service.post_product(CHOKLAD_PHOTO)
    service.store.put("pages", "pg-1", {**page_for(1), "productId": CHOKLAD_PHOTO["id"]})
    status, out = service.post_product(CHOKLAD_SCAN)
    assert out["product"]["id"] == CANON and out["product"]["imageUrl"] == CHOKLAD_PHOTO["imageUrl"]
    assert [p["id"] for p in service.store.all("products")] == [CANON]
    assert service.store.get("pages", "pg-1")["productId"] == CANON
    assert service.get_product(CHOKLAD_PHOTO["id"])[1]["product"]["id"] == CANON
    assert service.get_product("ikea-choklad-not-100-g")[1]["product"]["id"] == CANON
    assert service.canonical_id({"id": "x", "brand": "ikea", "productName": "Choklad Not", "size": "100gr"}) == CANON


@needs_pg
def test_a_photo_scan_meets_the_barcode_scan_whatever_the_brand_field(db):
    """Open Food Facts calls Takis' brand "Barcel" (the maker); a photo reads "Takis" off the pack: one product."""
    scan = {"id": "gtin-07501030424536", "brand": "Barcel", "productName": "Takis Fuego", "size": "56 g",
            "barcode": "7501030424536", "confidence": 0.85, "source": "claude"}
    photo = {"id": "takis-fuego-chile-y-limon-56g", "brand": "Takis", "productName": "Takis Fuego",
             "variant": "Fuego (chile y limón)", "size": "56 g", "confidence": 0.93, "source": "claude"}
    assert db.save_product(scan)["id"] == "gtin-07501030424536"
    assert db.save_product(photo)["id"] == "gtin-07501030424536"
    assert [r["id"] for r in rows(db, "SELECT id FROM products")] == ["gtin-07501030424536"]
    assert db.resolve("takis-fuego-chile-y-limon-56g") == "gtin-07501030424536"
    # two milks with a generic name and no barcode stay two products
    lala = {"id": "lala-leche-entera-1l", "brand": "Lala", "productName": "Leche Entera", "size": "1 L"}
    alpura = {"id": "alpura-leche-entera-1l", "brand": "Alpura", "productName": "Leche Entera", "size": "1 L"}
    assert db.save_product(lala)["id"] != db.save_product(alpura)["id"]


@needs_pg
def test_every_build_attempt_and_event_lands_in_postgres(tmp_path, kit_copy, db):
    def draft(workspace, message):
        return write_source(workspace, written_by="DRAFT: replace spot values with ones read from the page")

    service, _ = db_service(tmp_path, kit_copy, db, [draft, lambda w, m: {**write_source(w), "attempt": 2}])
    built = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    refused = wait(service, service.builds.start("https://www.amazon.com.mx/dp/B000", product=TAKIS).id)
    assert (built["status"], refused["status"]) == ("succeeded", "failed")
    build_id = built["result"]["agentRun"]["buildId"]

    (row,) = rows(db, "SELECT state, source, product_id, ended_at FROM builds WHERE id = %s", build_id)
    assert (row["state"], row["source"], row["product_id"]) == ("passed", "shop_mx", TAKIS["id"]) and row["ended_at"]
    attempts = rows(db, "SELECT n, verdict, sent_back, gate FROM build_attempts WHERE build_id = %s ORDER BY n", build_id)
    assert [(a["n"], a["verdict"], a["sent_back"]) for a in attempts] == [(1, "fail", True), (2, "pass", False)]
    assert {"expected_written"} <= {c["name"] for c in attempts[0]["gate"]["checks"] if not c["passed"]}
    assert "staged" not in attempts[0]["gate"]   # no paths from this machine
    stored = rows(db, "SELECT seq, kind FROM build_events WHERE build_id = %s ORDER BY seq", build_id)
    assert [e["seq"] for e in stored] == list(range(len(built["result"]["agentRun"]["events"])))
    assert {"system", "agent", "gate"} <= {e["kind"] for e in stored}

    service.jobs.items.clear()   # a restart: only the database remembers
    record = service.get_build(build_id)[1]
    assert [g["verdict"] for g in record["gates"]] == ["fail", "pass"]
    assert len(record["events"]) == len(stored) and record["events"][-1]["message"].endswith("is live")
    history = service.get_builds({})[1]
    assert [b["state"] for b in history["builds"]] == ["refused", "passed"]
    assert all(len(b["events"]) <= 5 for b in history["builds"])
    sites = {s["domain"]: s for s in history["sites"]}
    assert (sites["shop.example"]["passed"], sites["shop.example"]["source"]) == (1, "shop_mx")
    assert sites["amazon.com.mx"]["refused"] == 1
    assert history["totals"] == {"builds": 2, "passed": 1, "failed": 0, "refused": 1, "running": 0}
    assert [b["domain"] for b in service.get_builds({"domain": "shop.example"})[1]["builds"]] == ["shop.example"]
    assert db.import_builds(tmp_path / "data") == 0   # the JSON store holds the same two builds: nothing to add


@needs_pg
def test_builds_a_json_store_recorded_are_imported(tmp_path, kit_copy, db):
    service, _ = make_service(tmp_path, kit_copy, [lambda w, m: write_source(w)])   # no database yet
    wait(service, service.builds.start(PAGE, product=TAKIS).id)
    assert db.import_builds(tmp_path / "data") == 1 and db.import_builds(tmp_path / "data") == 0
    (build,) = db.list_builds()
    assert build["state"] == "passed" and build["attempts"][0]["verdict"] == "pass"
    assert db.get_build(build["buildId"])["gates"][0]["verdict"] == "pass"


@needs_pg
def test_an_imported_build_that_ended_mid_step_is_failed(tmp_path, db):
    # A build whose own git error left it "building" with endedAt set.
    from server.store import Store
    Store(tmp_path).put("builds", "b1", {"buildId": "b1", "provider": "devin", "url": PAGE, "domain": "shop.example",
                                         "state": "building", "note": "Gate: the backend is checking shop_mx",
                                         "attempts": [], "events": [], "startedAt": "2026-10-29T15:04:00.000Z",
                                         "endedAt": "2026-10-29T15:06:48.000Z"})
    assert db.import_builds(tmp_path) == 1
    (build,) = db.list_builds()
    assert build["state"] == "failed" and build["note"].startswith("Ended while building, without a final state")
