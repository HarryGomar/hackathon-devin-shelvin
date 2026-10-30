"""`POST /search`: pages that list the product, each with its access decision and scraper status.

Providers, in order: recorded results in backend/fixtures/search/ (matched by barcode, then brand and name), then
a web search: SEARCH=claude is the app's Claude search through the Messages API (web_search.py; no pages is a failure
with a reason, and each run's raw answer and cost is saved under data/search_runs/), SEARCH=agent a headless
Claude Code session. Every page then gets `access` from the kit (robots.txt and the AI-agent
opt-out rule), so the app can show refused sites as "Not collected" with the reason and an official alternative.
"""
import concurrent.futures
import json
import re
import shutil
import subprocess
import threading
import time
import unicodedata
from pathlib import Path

from .jobs import JobFailed
from .kit import domain_of
from .photo import shareable, with_product_photo
from .products import code_of, merge_identity, name_key
from .web_search import SearchError, check_links, normalize_url

STEPS = ["search", "verify", "rank"]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "search"

# Where to get the data instead, by host suffix. Sources: Amazon Creators API docs (Mexico locale), Mercado Libre
# developer docs, PROFECO's open data (QQP); see research_notes/.../mexico_retail_scraping.md.
ALTERNATIVES = {
    "amazon.com.mx": "Amazon's Creators API (needs an Amazon Associates México account)",
    "mercadolibre.com.mx": "Mercado Libre's developer API with an OAuth token",
    "lacomer.com.mx": "PROFECO's Quién es Quién en los Precios open data covers some La Comer stores",
    "soriana.com": "PROFECO's Quién es Quién en los Precios open data covers some Soriana stores",
    "walmart.com.mx": "PROFECO's Quién es Quién en los Precios open data covers some Walmart stores",
}
LABELS = {
    "ai_opt_out": "Blocks AI agents",
    "robots_disallow": "robots.txt disallows",
    "robots_unavailable": "robots.txt refused",
    "robots_unreachable": "Site unreachable",
    "blocked": "Blocks automated requests",
}


def slug(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def alternative(domain):
    for suffix, text in ALTERNATIVES.items():
        if domain == suffix or domain.endswith("." + suffix):
            return text
    return None


def _hash(text):
    """FNV-1a 32-bit over UTF-16 code units, in base 36: the app's `hash` in services/search/parse.ts."""
    h = 0x811C9DC5
    data = text.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= int.from_bytes(data[i:i + 2], "little")
        h = (h * 0x01000193) & 0xFFFFFFFF
    alphabet, out = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        h, r = divmod(h, 36)
        out = alphabet[r] + out
        if h == 0:
            return out


def page_id_for(url):
    """Stable page id from its URL (the app's `pageIdFor`): the same URL gets the same id in every search (spec 5)."""
    return f"web-{slug(domain_of(url)) or 'page'}-{_hash(normalize_url(url))}"


def _cost_line(run):
    """What the log says about a Claude run: model, tokens, searches, estimated cost."""
    usage = run.get("usage") or {}
    return {"model": run.get("model"), "in": usage.get("input"), "out": usage.get("output"),
            "searches": usage.get("searches"), "usd": run.get("usd"), "seconds": run.get("seconds")}


class Search:
    """The search job: recorded results first, then a cached web search, then a live one (a few at once)."""

    HOLD_SECONDS = 1.0          # verify and rank stay on screen about a second each (spec 7)
    EXPECTED_SECONDS = 60.0     # the clock behind `percent` while the web search runs (5 -> 70)

    def __init__(self, config, kit, store, agent_search=None, fixtures=FIXTURES, photo=None):
        self.config, self.kit, self.store, self.agent_search, self.fixtures = config, kit, store, agent_search, fixtures
        self.photo = photo or (lambda product: with_product_photo(product, timeout=3.0))
        self.slots = threading.BoundedSemaphore(max(1, getattr(config, "max_parallel_searches", 2)))
        self.cache = {}             # (product id, scanType, includeSimilar) -> (time, found)
        self.cache_lock = threading.Lock()
        # check_links(pages, product, may_fetch) -> (pages, counts); None in tests that must stay offline.
        self.link_check = check_links if getattr(config, "search", "") in ("claude", "agent") else None

    def recorded(self, product):
        """The recorded search whose barcodes hold this product's (compared as GTIN-14, products.code_of), else whose
        names have its name key (brand + name + size, products.name_key)."""
        code, key = code_of({"barcode": product.get("barcode")}), name_key(product)
        for path in sorted(Path(self.fixtures).glob("*.json")):
            recorded = json.loads(path.read_text(encoding="utf-8"))
            keys = recorded.get("match", {})
            if code and code in {code_of({"barcode": b}) for b in keys.get("barcodes", [])}:
                return recorded
            if key and key in {name_key({"productName": n}) for n in keys.get("names", [])}:
                return recorded
        return None

    @staticmethod
    def cache_keys(request):
        """By product id, and by barcode too: the same pack scanned again (or named differently) is the same search."""
        rest = (request.get("scanType", "both"), bool(request.get("includeSimilar")))
        keys = [(request["product"]["id"], *rest)]
        code = code_of({"barcode": request["product"].get("barcode")})
        if code:
            keys.append((f"barcode:{code}", *rest))
        return keys

    def cached(self, request):
        with self.cache_lock:
            hits = [h for h in (self.cache.get(k) for k in self.cache_keys(request)) if h]
        hits = [h for h in hits if time.time() - h[0] < self.config.search_cache_hours * 3600]
        return max(hits, key=lambda h: h[0])[1] if hits else None

    def costs_money(self, request):
        """True when this search would run a paid web search (no recorded result, nothing cached)."""
        return (self.agent_search is not None and self.recorded(request["product"]) is None
                and self.cached(request) is None)

    def page(self, found, product, index=0):
        url = found["url"]
        domain = domain_of(url)
        access = dict(self.kit.access(url))
        blocked = self.store.get("blocked_sites", domain) if access["status"] == "allowed" else None
        if blocked:   # a scraper build saw 401/403/429 or a bot challenge, which robots.txt doesn't say
            access = {k: blocked[k] for k in ("status", "code", "reason")}
        if access["status"] != "allowed":
            access["label"] = LABELS.get(access["code"], "Refused")
            access["alternative"] = alternative(domain)
        source = self.kit.source_for(url)
        # A refused page is never available (spec 8, Refusals), even when a source exists for its host.
        scraper = ({"status": "available", "scraperId": source.SOURCE}
                   if source is not None and access["status"] == "allowed" else {"status": "missing"})
        return {"id": page_id_for(url),
                "url": url, "domain": domain, "retailerName": found.get("retailerName") or domain,
                "sourceType": found.get("sourceType", "third_party"), "title": found.get("title") or url,
                "matchType": found.get("matchType", "exact"),
                **({"similarProductId": found["similarProductId"]} if found.get("similarProductId") else {}),
                "verification": found.get("verification") or {"status": "uncertain", "confidence": 0.5,
                                                              "reason": "Found by web search; not checked"},
                "scraper": scraper, "access": access}

    def _clock(self, job, message, stop):
        """While the web search runs, move `percent` from 5 toward 70 with the clock."""
        started = time.time()
        while not stop.wait(1.0):
            share = min(1.0, (time.time() - started) / self.EXPECTED_SECONDS)
            job.step("search", message, 5 + round(65 * share))

    def _find(self, job, product, request, search_id):
        found = self.recorded(product)
        if found is not None:
            job.log["provider"] = "fixture"
            return found
        found = self.cached(request)
        if found is not None:
            job.log["provider"] = "cache"
            return found
        if self.agent_search is None:
            return None
        message = f"Searching Mexican stores for {product.get('productName')}"
        job.step("search", "Waiting for a free search slot", 5)
        with self.slots:
            job.step("search", message, 5)
            stop = threading.Event()
            threading.Thread(target=self._clock, args=(job, message, stop), daemon=True).start()
            try:
                found = self.agent_search(product, request)
            except SearchError as exc:
                if getattr(exc, "run", None):
                    self.store.put("search_runs", search_id, exc.run)
                    job.log["claude"] = _cost_line(exc.run)
                raise JobFailed(str(exc)) from None
            finally:
                stop.set()
        job.log["provider"] = self.config.search
        if found is not None and found.get("run"):
            run = found.pop("run")
            self.store.put("search_runs", search_id, run)
            job.log["claude"] = _cost_line(run)
        if found is not None and found.get("pages"):
            with self.cache_lock:
                for key in self.cache_keys(request):
                    self.cache[key] = (time.time(), found)
        return found

    def run(self, job, request, search_id):
        product, scan_type = request["product"], request.get("scanType", "both")
        none_found = (f"No store pages found for {product.get('productName')}. "
                      "Check the name and size, then try again.")
        job.step("search", f"Searching the web for {product.get('productName')}", 5)
        found = self._find(job, product, request, search_id)
        if found is None:
            raise JobFailed(none_found)
        wanted = [p for p in found["pages"] if scan_type == "both" or p.get("sourceType") == scan_type]
        if not request.get("includeSimilar"):
            wanted = [p for p in wanted if p.get("matchType", "exact") == "exact"]
        if not wanted:
            raise JobFailed(none_found)
        verify_started = time.time()
        job.step("verify", f"Found {len(wanted)} pages on {len({domain_of(p['url']) for p in wanted})} sites; "
                           "checking robots.txt and scrapers on each", 75)
        pages, seen = [], set()
        # robots.txt per site and the link check run side by side: a cold verify step was one fetch after another.
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            checked = list(pool.map(lambda p: self.page(p, product), wanted))
        for page in checked:
            if page["id"] not in seen:          # the same URL twice (exact and similar): keep the first
                seen.add(page["id"])
                pages.append(page)
        if self.link_check and job.log.get("provider") not in ("fixture",):
            # A dead link or a live title naming another size: only on pages robots.txt lets the kit fetch.
            pages, counts = self.link_check(pages, product, lambda page: page["access"]["status"] == "allowed")
            job.log["links"] = counts
            if not pages:
                raise JobFailed(none_found)
        # A product with no photo gets one from Open Food Facts; a phone-local photo is never stored for others.
        shown = self.photo(product) if not product.get("imageUrl") else product
        stored = shown if shown.get("imageSource") != "user_photo" else shareable(self.photo(product))
        time.sleep(max(0.0, self.HOLD_SECONDS - (time.time() - verify_started)))
        job.step("rank", "Ranking the brand's own site first, then retailers", 90)
        order = {"available": 0, "missing": 1, "building": 1, "failed": 2}
        pages.sort(key=lambda p: (p["access"]["status"] != "allowed", p["matchType"] != "exact",
                                  p["sourceType"] != "first_party", p["verification"]["status"] == "rejected",
                                  order.get(p["scraper"]["status"], 3)))
        similar = found.get("similarProducts", []) if request.get("includeSimilar") else []
        similar_ids = {s.get("id") for s in similar}
        pages = [p for p in pages if p["matchType"] != "similar" or p.get("similarProductId") in similar_ids]
        result = {"searchId": search_id, "product": shown, "pages": pages, "similarProducts": similar,
                  "recordedBy": found.get("recordedBy")}
        time.sleep(self.HOLD_SECONDS)
        for page in pages:
            self.store.put("pages", page["id"], {**page, "productId": product.get("id"), "searchId": search_id})
        self.store.put("searches", search_id, {**result, "product": stored})
        # Through the merge: a stored identity's fields (a known barcode above all) are kept, never overwritten.
        self.store.put("products", product["id"],
                       merge_identity(self.store.get("products", product["id"]), stored, product["id"]))
        job.log["pages"] = len(pages)
        return {**result, "_stored_product": stored}


def claude_search(config):
    """An agent web search through headless Claude Code (WebSearch and WebFetch only), as recorded results."""
    binary = shutil.which(config.claude_bin) or config.claude_bin

    def search(product, request=None):
        prompt = f"""Find web pages in Mexico that sell or describe this product: {json.dumps(product, ensure_ascii=False)}.
First the brand's own official site (sourceType first_party): the product's page, or the brand's catalog page.
Then retailer product pages (third_party): Walmart Súper, Soriana, Chedraui, La Comer, Bodega Aurrera, Amazon México,
Mercado Libre, and others. Only URLs you saw in search results or opened; never invent a URL. Answer with only this
JSON: {{"pages": [{{"url": "...", "retailerName": "...", "sourceType": "first_party|third_party", "title": "...",
"matchType": "exact", "verification": {{"status": "verified|uncertain|rejected", "confidence": 0.0, "reason": "..."}}}}]}}"""
        done = subprocess.run([binary, "-p", "--model", config.claude_model, "--max-turns", "30", "--output-format",
                               "json", "--allowedTools", "WebSearch", "WebFetch"], input=prompt, capture_output=True,
                              encoding="utf-8", errors="replace", timeout=600)
        try:
            text = json.loads(done.stdout)["result"]
            found = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        except (json.JSONDecodeError, KeyError, AttributeError):
            return None
        found["recordedBy"] = "claude code web search"
        return found

    return search
