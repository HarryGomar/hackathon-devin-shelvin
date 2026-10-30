"""The HTTP API of docs/api-contract.md, on the standard library's threading server."""
import hmac
import json
import re
import subprocess
import threading
import time
import traceback
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, unquote, urlsplit

from . import scrape as scrape_steps
from . import search as search_steps
from .builds import Builds, history
from .db import Database, gate_record
from .jobs import Jobs
from .builds import installed_sites
from .kit import Kit, domain_of
from .devin_search import DevinSearch
from .runners import ClaudeCodeRunner, DevinRunner, RecordedRunner
from .scrape import Scrape
from .search import Search, claude_search
from .web_search import ClaudeSearch
from .store import Store
from .config import REPO
from .log import log
from .photo import shareable
from .products import choose, merge_identity


class ApiError(Exception):
    """A non-2xx answer; its body is `{"error": message, "code": code}` (spec 2)."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def git_version():
    """The checkout's short commit, for `/health`; `VERSION` in the environment wins (a deploy without .git)."""
    import os
    if os.environ.get("VERSION"):
        return os.environ["VERSION"]
    try:
        done = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True, timeout=5)
        return done.stdout.strip() or "dev"
    except (OSError, subprocess.SubprocessError):
        return "dev"


class Budget:
    """Daily caps on what costs money (spec 10): paid web searches and scraper builds. Resets at local midnight."""

    def __init__(self, limits):
        self.limits, self.day, self.used, self.lock = limits, date.today(), {}, threading.Lock()

    def take(self, kind, message):
        with self.lock:
            if date.today() != self.day:
                self.day, self.used = date.today(), {}
            if self.used.get(kind, 0) >= self.limits.get(kind, 0):
                raise ApiError(429, "over_budget", message)
            self.used[kind] = self.used.get(kind, 0) + 1


def _url(value):
    part = urlsplit(str(value or "").strip())
    if part.scheme not in ("http", "https") or not part.hostname or "." not in part.hostname:
        raise ApiError(400, "invalid_url", "That does not look like a product page URL")
    return part.geturl()


class Service:
    def __init__(self, config, *, kit=None, runner=None, store=None, agent_search=None, scrape_fetch=None, db=None):
        self.config = config
        self.store = store or Store(config.data_dir)
        # Postgres (DATABASE_URL) keeps products, pages, scrape runs and listings; the JSON store keeps working
        # beside it for jobs, builds and the scrape's own reads.
        if db is None and config.database_url:
            db = Database(config.database_url)
            db.migrate()
        self.db = db
        self.jobs = Jobs()
        self.kit = kit or Kit(config.kit_dir)
        if runner is None:
            runners = {"devin": DevinRunner, "claude_code": ClaudeCodeRunner, "scripted": RecordedRunner}
            if config.agent not in runners:
                raise ValueError(f"AGENT must be one of {', '.join(runners)}, not {config.agent!r}")
            runner = runners[config.agent](config, self.kit)
        if agent_search is None:
            searches = {"claude": ClaudeSearch, "devin": DevinSearch, "agent": claude_search, "fixtures": None, "fixture": None}
            if config.search not in searches:
                raise ValueError(f"SEARCH must be one of {', '.join(searches)}, not {config.search!r}")
            agent_search = searches[config.search] and searches[config.search](config)
        self.builds = Builds(config, self.store, self.jobs, self.kit, runner, on_available=self._available, db=db)
        self.builds.live_gate = config.gate_live
        if db is not None:
            db.import_builds(config.data_dir)   # builds recorded before the database was on, so history has them
        self.search = Search(config, self.kit, self.store, agent_search)
        self.scrape = Scrape(self.kit, self.store, scrape_fetch, parallel=config.max_parallel_scrapes)
        self.budget = Budget({"search": config.max_searches_per_day, "build": config.max_builds_per_day})
        self.version = git_version()

    # --- endpoints -------------------------------------------------------------------------------------------
    def health(self):
        """Fast and local: no upstream calls (spec 2)."""
        return 200, {"ok": True, "version": self.version, "agent": self.builds.runner.provider,
                     "search": self.config.search, "auth": bool(self.config.api_token)}

    def post_search(self, body):
        product = body.get("product")
        if not isinstance(product, dict) or not isinstance(product.get("id"), str) or not product["id"].strip():
            raise ApiError(400, "invalid_request", "A product with an id is required")
        if not (product.get("brand") or product.get("productName")):
            raise ApiError(400, "invalid_request", "The product needs a brand or a product name")
        if body.get("scanType", "both") not in ("both", "first_party", "third_party"):
            raise ApiError(400, "invalid_request", "scanType must be first_party, third_party or both")
        # The search runs (and its cache, pages and records are keyed) under the product's canonical id, so the
        # same product scanned under another name is the same search and the same saved product.
        body = {**body, "product": {**product, "id": self.canonical_id(product)}}
        if self.search.costs_money(body):
            self.budget.take("search", "Daily search limit reached. Try again tomorrow.")
        job = self.jobs.create("search", search_steps.STEPS)
        return 202, self.jobs.run(job, lambda j: self._search(j, body, f"srch_{j.id}", product["id"])).view()

    def _search(self, job, body, search_id, sent_id):
        result = self.search.run(job, body, search_id)
        stored = result.pop("_stored_product", result["product"])
        if self.db is not None:
            product_id = self.db.save_search({**result, "product": stored})
        else:
            product_id = self._store_save_product(stored)["id"]
        # The app keeps using the id it sent (the contract), so that id must lead to the stored product: record it
        # as an alias. Without one, a later scrape under the sent id finds no product and saves a blank one.
        self.add_alias(sent_id, product_id)
        return {**result, "product": {**result["product"], "id": sent_id}}

    def add_alias(self, old_id, product_id):
        """Make `old_id` lead to `product_id`, unless `old_id` is a stored product of its own."""
        if old_id == product_id:
            return
        if self.db is not None:
            self.db.add_alias(old_id, product_id)
        elif self.store.get("products", old_id) is None:
            self.store.put("aliases", old_id, {"productId": product_id})

    # --- product identity ----------------------------------------------------------------------------------------
    def canonical_id(self, product):
        """The id this identity is saved under (server/products.py): `gtin-<GTIN-14>` with a valid barcode, else
        the stored product with the same name key, else its own id."""
        if self.db is not None:
            return self.db.canonical_id(product)
        return choose(product, self.store.all("products"), self._store_resolve(product["id"]))[0]

    def resolve_product_id(self, product_id):
        """The stored product an id names, following aliases left by merges; the id itself when unknown."""
        if self.db is not None:
            return self.db.resolve(product_id) or product_id
        return self._store_resolve(product_id) or product_id

    def _store_resolve(self, product_id):
        if self.store.get("products", product_id) is not None:
            return product_id
        alias = self.store.get("aliases", product_id)
        return alias["productId"] if alias and self.store.get("products", alias["productId"]) is not None else None

    def _store_save_product(self, product, product_id=None):
        """Save an identity in the JSON store under its canonical id (or `product_id`, the one Postgres chose),
        folding stored duplicates in: their pages, listings and scans move over and their ids become aliases."""
        with self.store.lock:
            return self._store_save_locked(product, product_id)

    def _store_save_locked(self, product, product_id):
        stored = self.store.all("products")
        target, absorb = choose(product, stored, self._store_resolve(product["id"]))
        if product_id is not None:
            target, absorb = product_id, [i for i in absorb if i != product_id]
        by_id = {p["id"]: p for p in stored}
        merged = {}
        for old in [*absorb, target]:
            merged = merge_identity(merged, by_id.get(old), target)
        merged = merge_identity(merged, product, target)
        self.store.put("products", target, merged)
        for old in absorb:
            for page in self.store.all("pages"):
                if page.get("productId") == old:
                    self.store.put("pages", page["id"], {**page, "productId": target})
            for kind in ("listings", "scans", "failures"):
                record = self.store.get(kind, old)
                if record is not None and self.store.get(kind, target) is None:
                    if isinstance(record, dict) and isinstance(record.get("product"), dict):
                        record = {**record, "product": merged}
                    self.store.put(kind, target, record)
                self.store.delete(kind, old)
            self.store.delete("products", old)
        for old in {*absorb, product["id"]} - {target}:
            if self.store.get("products", old) is None:
                self.store.put("aliases", old, {"productId": target})
        return merged

    def post_match(self, body):
        urls = body.get("urls")
        if not isinstance(urls, list) or not all(isinstance(u, str) for u in urls):
            raise ApiError(400, "invalid_request", "urls must be a list of URLs")
        matches = []
        for url in urls:
            source = self.kit.source_for(url) if urlsplit(url).hostname else None
            if source is not None and self._refused(url):
                source = None   # a site that refuses collection is never available (spec 5)
            building = self.builds.active.get(domain_of(url))
            match = {"url": url, "domain": domain_of(url),
                     "status": "available" if source else ("building" if building else "missing")}
            if source:
                match["scraperId"] = source.SOURCE
            if building and not source:
                match["buildJobId"] = building.id
            matches.append(match)
        return 200, {"matches": matches}

    def _refused(self, url):
        """The search's access decision for this URL, if a page with it is saved (no robots fetch here: 2 s budget)."""
        page = next((p for p in self.store.all("pages") if p["url"] == url), None)
        return bool(page and (page.get("access") or {}).get("status") == "refused")

    def post_build(self, body):
        url = _url(body.get("url"))
        if self.builds.active.get(domain_of(url)) is None and self.kit.source_for(url) is None:
            self.budget.take("build", "Daily scraper build limit reached. Try again tomorrow.")
        page = self._page_for(url, body.get("pageId"))
        product_id = self.resolve_product_id(body.get("productId") or (page or {}).get("productId") or "")
        product = self.store.get("products", product_id) or {}
        kind = (page or {}).get("sourceType") or body.get("kind") or "third_party"
        job = self.builds.start(url, product=product, kind=kind, page_id=(page or {}).get("id"),
                                user_added=page is None)
        return 202, job.view()

    def post_build_batch(self, body):
        """One build per missing host among the pages, run in parallel (MAX_PARALLEL_BUILDS sessions at once)."""
        builds, skipped, seen = [], [], set()
        for page_id in body.get("pageIds") or []:
            page = self.store.get("pages", page_id)
            if page is None:
                skipped.append({"pageId": page_id, "domain": None, "code": "unknown_page", "reason": "unknown page"})
                continue
            if page.get("access", {}).get("status") == "refused":
                skipped.append({"pageId": page_id, "domain": page["domain"], "code": page["access"]["code"],
                                "reason": page["access"]["reason"]})
                continue
            if self.kit.source_for(page["url"]) is not None:
                skipped.append({"pageId": page_id, "domain": page["domain"], "code": "has_scraper",
                                "reason": "already has a scraper"})
                continue
            job = self.builds.start(page["url"], product=self.store.get("products", page.get("productId") or ""),
                                    kind=page["sourceType"], page_id=page_id)
            builds.append({"pageId": page_id, "domain": page["domain"], "jobId": job.id, "duplicate": page["domain"] in seen})
            seen.add(page["domain"])
        return 202, {"builds": builds, "skipped": skipped, "parallel": self.config.max_parallel_builds}

    def post_scrape(self, body):
        page_ids = body.get("pageIds")
        if (not isinstance(body.get("productId"), str) or not body["productId"] or not isinstance(page_ids, list)
                or not page_ids or not all(isinstance(i, str) for i in page_ids)):
            raise ApiError(400, "invalid_request", "productId and pageIds are required")
        body = {**body, "productId": self.resolve_product_id(body["productId"])}   # an old id scrapes its product
        job = self.jobs.create("scrape", scrape_steps.STEPS)
        return 202, self.jobs.run(job, lambda j: self._scrape(j, body, f"run_{j.id}")).view()

    def _scrape(self, job, body, run_id):
        if self.db is None:
            return self.scrape.run(job, body, run_id)
        product = (self.store.get("products", body["productId"]) or self.db.get_product(body["productId"])
                   or {"id": body["productId"]})
        if self.store.get("products", product["id"]) is None:
            self.store.put("products", product["id"], product)   # the scrape reads its product from the store
        pages = [p for p in (self.store.get("pages", i) for i in body["pageIds"]) if p is not None]
        product_id = self.db.start_run(run_id, product, pages)
        if product_id != product["id"]:   # the scrape reads and writes the JSON store under the canonical id too
            self.store.put("products", product_id, {**product, "id": product_id})
            body = {**body, "productId": product_id}
        try:
            result = self.scrape.run(job, body, run_id)
        except Exception:
            self.db.finish_run(run_id, product_id, "failed")
            raise
        self.db.finish_run(run_id, product_id, "succeeded", result["listings"], result["failures"])
        return result

    def get_job(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", f"Job {job_id} not found")
        return 200, job.view()

    def get_scans(self):
        if self.db is not None:
            return 200, {"scans": self.db.scans()}
        scans = sorted(self.store.all("scans"), key=lambda s: s.get("lastScrapedAt") or "", reverse=True)[:50]
        return 200, {"scans": [{**s, "product": shareable(s.get("product"))} for s in scans]}

    def get_listings(self, product_id):
        if self.db is not None:
            saved = self.db.product_listings(product_id)
        else:
            product_id = self.resolve_product_id(product_id)
            saved = self.store.get("listings", product_id)
            if saved is None and self.store.get("products", product_id) is not None:
                saved = {"product": self.store.get("products", product_id), "listings": []}
            if saved is not None:
                listed = {l["pageId"] for l in saved["listings"]}
                failures = [f for f in self.scrape.failures_for(product_id) if f["pageId"] not in listed]
                # Stores verified to sell it that refuse collection, never scraped: one per store (as db.open_failures).
                stores = {domain_of(f["url"]) for f in failures}
                for page in self.store.all("pages"):
                    if (page.get("productId") != product_id or page["id"] in listed or page["domain"] in stores
                            or (page.get("access") or {}).get("status") != "refused"
                            or (page.get("verification") or {}).get("status") != "verified"):
                        continue
                    stores.add(page["domain"])
                    failures.append({"pageId": page["id"], "url": page["url"], "code": page["access"].get("code") or "blocked",
                                     "error": page["access"].get("reason") or "The site refuses automated collection",
                                     "retailerName": page.get("retailerName") or page["domain"]})
                saved = {**saved, "product": shareable(saved["product"]),
                         "listings": sorted(saved["listings"], key=lambda l: l.get("scrapedAt") or "", reverse=True),
                         **({"failures": failures} if failures else {})}
        if saved is None:
            raise ApiError(404, "not_found", f"Product {product_id} not found")
        return 200, saved

    # --- products ----------------------------------------------------------------------------------------------
    def post_product(self, body):
        """Save (upsert) a ProductIdentity the user confirmed: `{product}` or the identity itself."""
        product = body.get("product", body)
        if not isinstance(product, dict) or not isinstance(product.get("id"), str) or not product["id"].strip():
            raise ApiError(400, "invalid_request", "A product with an id is required")
        if not (product.get("brand") or product.get("productName")):
            raise ApiError(400, "invalid_request", "A product needs a brand or a product name")
        if self.db is not None:
            saved = self.db.save_product(product)   # the canonical id and the merged identity
            self._store_save_product(product, saved["id"])
            return 200, {"product": saved}
        return 200, {"product": shareable(self._store_save_product(product))}

    def get_products(self, query):
        try:
            limit = min(max(int(query.get("limit") or 50), 1), 200)
            offset = max(int(query.get("offset") or 0), 0)
        except ValueError:
            raise ApiError(400, "invalid_request", "limit and offset must be numbers") from None
        q, barcode = (query.get("q") or "").strip(), (query.get("barcode") or "").strip()
        if self.db is not None:
            return 200, self.db.list_products(q or None, barcode or None, limit, offset)
        found = [p for p in self.store.all("products")
                 if (not q or q.lower() in f"{p.get('brand', '')} {p.get('productName', '')}".lower())
                 and (not barcode or (p.get("barcode") or "").lstrip("0") == barcode.lstrip("0"))]
        return 200, {"products": found[offset:offset + limit], "total": len(found), "limit": limit, "offset": offset}

    def get_product(self, product_id):
        if self.db is not None:
            detail = self.db.product_detail(product_id)
        else:
            product_id = self.resolve_product_id(product_id)
            product = self.store.get("products", product_id)
            detail = product and {
                "product": product,
                "pages": [{k: v for k, v in p.items() if k not in ("productId", "searchId")}
                          for p in self.store.all("pages") if p.get("productId") == product_id],
                "listings": (self.store.get("listings", product_id) or {}).get("listings", [])}
        if detail is None:
            raise ApiError(404, "not_found", f"Product {product_id} not found")
        return 200, detail

    def get_builds(self, query):
        """Every recorded build, newest first, and a per-site tally (Postgres when it is on, else the JSON store).
        Builds running now come from memory, which is ahead of both."""
        try:
            limit = min(max(int(query.get("limit") or 50), 1), 200)
        except ValueError:
            raise ApiError(400, "invalid_request", "limit must be a number") from None
        domain, state = (query.get("domain") or "").strip() or None, (query.get("state") or "").strip() or None
        live = {r["buildId"]: r for r in self.builds.runs()}
        if self.db is not None:
            every = {r["buildId"]: r for r in self.db.build_rows()}
            listed = {r["buildId"]: r for r in self.db.list_builds(domain, state, limit)}
        else:
            every = {r["buildId"]: r for r in self.store.all("builds")}
            listed = dict(every)
        newest = lambda runs: sorted(runs, key=lambda r: r["startedAt"], reverse=True)
        sites, totals = history(newest({**every, **live}.values()))
        sites = installed_sites(sites, self.kit.sources())
        wanted = [r for r in {**listed, **live}.values()
                  if (domain is None or r["domain"] == domain) and (state is None or r["state"] == state)]
        return 200, {"builds": [{**r, "events": r.get("events", [])[-5:]} for r in newest(wanted)[:limit]],
                     "sites": sites, "totals": totals,
                     "running": self.builds.running, "parallel": self.config.max_parallel_builds}

    def get_build(self, build_id):
        """One build's whole recording: every event, every attempt and the gate's report on each attempt."""
        job = self.jobs.get(build_id)
        if job is not None and hasattr(job, "run_record"):
            run = job.run_record
            return 200, {**run.view(events=0), "gates": [run.gates.get(a["n"]) for a in run.attempts]}
        record = self.db.get_build(build_id) if self.db is not None else None
        if record is not None:
            return 200, record
        record = self.store.get("builds", build_id)
        if record is None:
            raise ApiError(404, "not_found", f"Build {build_id} not found")
        return 200, {**record, "gates": [gate_record(self.store.get("gates", f"{build_id}-{a['n']}"))
                                         for a in record["attempts"]]}

    # --- pages -----------------------------------------------------------------------------------------------
    def _page_for(self, url, page_id):
        if page_id:
            return self.store.get("pages", page_id)
        return next((p for p in self.store.all("pages") if p["url"] == url), None)

    def _available(self, run):
        """A build passed (or a source already existed): every saved page on that host now has a scraper."""
        scraper = {"status": "available", "scraperId": run.source}
        updated = None
        for page in self.store.all("pages"):
            if page["domain"] == run.domain:
                page["scraper"] = scraper
                self.store.put("pages", page["id"], page)
                if page["id"] == run.page_id or (updated is None and page["url"] == run.url):
                    updated = page
        if updated is None:
            updated = {"id": f"user-{run.id}", "url": run.url, "domain": run.domain, "retailerName": run.domain,
                       "sourceType": run.kind, "title": run.url, "matchType": "exact",
                       "verification": {"status": "user_added", "confidence": 1, "reason": "Added by you"},
                       "scraper": scraper, "access": run.access or {"status": "allowed", "code": "allowed", "reason": ""},
                       "productId": run.product.get("id")}
            self.store.put("pages", updated["id"], updated)
            if self.db is not None and updated["productId"] and self.db.get_product(updated["productId"]):
                self.db.save_page(updated, updated["productId"])
        if self.db is not None:
            self.db.set_scraper(run.domain, scraper)
        return {k: v for k, v in updated.items() if k not in ("productId", "searchId")}


ROUTES = [
    ("POST", re.compile(r"^/search$"), lambda s, m, b: s.post_search(b)),
    ("POST", re.compile(r"^/scrapers/match$"), lambda s, m, b: s.post_match(b)),
    ("POST", re.compile(r"^/scrapers/build$"), lambda s, m, b: s.post_build(b)),
    ("POST", re.compile(r"^/scrapers/build-batch$"), lambda s, m, b: s.post_build_batch(b)),
    ("POST", re.compile(r"^/scrape$"), lambda s, m, b: s.post_scrape(b)),
    ("GET", re.compile(r"^/jobs/([^/]+)$"), lambda s, m, b: s.get_job(m.group(1))),
    ("GET", re.compile(r"^/scans$"), lambda s, m, b: s.get_scans()),
    ("GET", re.compile(r"^/products/([^/]+)/listings$"), lambda s, m, b: s.get_listings(m.group(1))),
    ("POST", re.compile(r"^/products$"), lambda s, m, b: s.post_product(b)),
    ("GET", re.compile(r"^/products$"), lambda s, m, b: s.get_products(b)),
    ("GET", re.compile(r"^/products/([^/]+)$"), lambda s, m, b: s.get_product(m.group(1))),
    ("GET", re.compile(r"^/builds$"), lambda s, m, b: s.get_builds(b)),
    ("GET", re.compile(r"^/builds/([^/]+)$"), lambda s, m, b: s.get_build(m.group(1))),
    ("GET", re.compile(r"^/health$"), lambda s, m, b: s.health()),
]
OPEN_PATHS = {"/health"}   # everything else needs the team token when API_TOKEN is set


def authorized(service, header):
    """`Authorization: Bearer <API_TOKEN>`, compared in constant time. No API_TOKEN: auth is off (local dev)."""
    token = service.config.api_token
    if not token:
        return True
    scheme, _, given = (header or "").partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(given.strip().encode(), token.encode())


def handler_for(service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status, body, close=False):
            data = b"" if status == 204 else json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            if status != 204:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(data)
            self._status = status
            if isinstance(body, dict) and isinstance(body.get("jobId"), str):
                self._job_id = body["jobId"]

        def _error(self, status, code, message, close=False):
            self._send(status, {"error": message, "code": code}, close=close)

        def _route(self, method):
            started, self._status, self._job_id = time.time(), 0, None
            parts = urlsplit(self.path)
            path = unquote(parts.path.rstrip("/") or "/")
            try:
                self._handle(method, parts, path)
            finally:
                log("request", method=method, path=path, status=self._status,
                    ms=round(1000 * (time.time() - started)), jobId=self._job_id)

        def _handle(self, method, parts, path):
            try:
                if path not in OPEN_PATHS and not authorized(service, self.headers.get("Authorization")):
                    # A body we won't read must not be parsed as the next request on this connection.
                    raise ApiError(401, "unauthorized", "Missing or wrong team token")
                body = {}
                if method == "POST":
                    try:
                        length = int(self.headers.get("Content-Length") or 0)
                    except ValueError:
                        raise ApiError(400, "invalid_request", "Bad Content-Length") from None
                    if length > service.config.max_body_bytes:
                        return self._error(413, "too_large",
                                           f"The request body is over {service.config.max_body_bytes // 1_000_000 or 1} MB",
                                           close=True)
                    raw = self.rfile.read(length) if length else b""
                    try:
                        body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        raise ApiError(400, "invalid_request", "The body is not JSON") from None
                    if not isinstance(body, dict):
                        raise ApiError(400, "invalid_request", "The body must be a JSON object")
                else:
                    body = dict(parse_qsl(parts.query))   # a GET's query string (?q=...&limit=...)
                known = False
                for verb, pattern, call in ROUTES:
                    match = pattern.match(path)
                    if match:
                        known = True
                        if verb == method:
                            status, out = call(service, match, body)
                            return self._send(status, out)
                raise ApiError(404, "not_found", f"No route {method} {path}" if not known else
                               f"{path} does not take {method}")
            except ApiError as exc:
                self._error(exc.status, exc.code, exc.message, close=exc.status == 401 and method == "POST")
            except Exception as exc:   # our bug: a short message for the app, the trace in the log
                traceback.print_exc()
                self._error(500, "internal", f"Server error ({type(exc).__name__}). Try again.")

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_OPTIONS(self):
            # CORS preflight for the web preview (spec 2): no token needed.
            started = time.time()
            self._send(204, {})
            log("request", method="OPTIONS", path=urlsplit(self.path).path, status=204,
                ms=round(1000 * (time.time() - started)))

        def log_message(self, fmt, *args):   # the per-request line is ours (no client addresses)
            pass

    return Handler


def serve(config, service=None):
    service = service or Service(config)
    if not config.api_token:
        log("warning", message="API_TOKEN is not set: auth is OFF and the server listens on 127.0.0.1 only (HOST overrides).")
    server = ThreadingHTTPServer((config.host, config.port), handler_for(service))
    server.daemon_threads = True
    return server, service
