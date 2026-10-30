"""`SEARCH=claude`: the app's Claude page search (app/src/services/search/parse.ts and claude.ts), run in the backend.

One Messages API call with the server-side web_search tool, located in Mexico and limited to the Mexican retailers plus
the brand's likely own domains. The answer is checked like the app checks it: the domain decides first or third
party, a URL the search never returned is not `verified`, rejected near misses are kept, duplicates are dropped.
Differences from the app: an empty answer is retried once with a broader hint, a store's own brand (IKEA) counts as
first party, and every run's raw answer, usage and cost is returned for the store.

Pure functions first (tested offline in tests/test_web_search.py), the HTTP call last.
"""
import concurrent.futures
import http.client
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request

# Mexican retailers Claude may return as third-party pages. Most specific domain first.
MX_RETAILERS = [
    {"key": "walmart", "domain": "super.walmart.com.mx", "retailerName": "Walmart Súper"},
    {"key": "walmart-mx", "domain": "walmart.com.mx", "retailerName": "Walmart México"},
    {"key": "soriana", "domain": "soriana.com", "retailerName": "Soriana"},
    {"key": "chedraui", "domain": "chedraui.com.mx", "retailerName": "Chedraui"},
    {"key": "lacomer", "domain": "lacomer.com.mx", "retailerName": "La Comer"},
    {"key": "bodega", "domain": "despensa.bodegaaurrera.com.mx", "retailerName": "Bodega Aurrera Despensa"},
    {"key": "bodega-mx", "domain": "bodegaaurrera.com.mx", "retailerName": "Bodega Aurrera"},
    {"key": "heb", "domain": "heb.com.mx", "retailerName": "HEB México"},
    {"key": "amazon", "domain": "amazon.com.mx", "retailerName": "Amazon México"},
    {"key": "mercadolibre", "domain": "mercadolibre.com.mx", "retailerName": "Mercado Libre"},
]

# Searched domains for retailers (subdomains are covered, so the parents are enough).
RETAILER_SEARCH_DOMAINS = ["walmart.com.mx", "soriana.com", "chedraui.com.mx", "lacomer.com.mx",
                           "bodegaaurrera.com.mx", "heb.com.mx", "amazon.com.mx", "mercadolibre.com.mx"]

# Kept out of the open search for the brand's own page (first-party only scans).
FIRST_PARTY_BLOCKED = [*RETAILER_SEARCH_DOMAINS, "walmart.com", "amazon.com", "mercadolibre.com", "facebook.com",
                       "instagram.com", "tiktok.com", "youtube.com", "x.com", "wikipedia.org", "openfoodfacts.org",
                       "profeco.gob.mx"]

LIMITS = {"exactPages": 12, "similarProducts": 4, "pagesPerSimilar": 2}
VERDICTS = ("verified", "uncertain", "rejected")
STATUS_RANK = {"user_added": 0, "verified": 1, "uncertain": 2, "rejected": 3}

# List prices (US$ per token / per search) for the run record; an unknown model is priced as Opus 5.5.
PRICE = {"input": 4 / 1e6, "output": 20 / 1e6, "cacheRead": 0.2 / 1e6, "cacheWrite": 5 / 1e6, "search": 0.01}
PRICES = {"claude-opus-5-5": PRICE,
          "claude-sonnet-5-5": {"input": 2 / 1e6, "output": 10 / 1e6, "cacheRead": 0.2 / 1e6, "cacheWrite": 2.5 / 1e6, "search": 0.01},
          "claude-haiku-5-5": {"input": 0.1 / 1e6, "output": 0.5 / 1e6, "cacheRead": 0.01 / 1e6, "cacheWrite": 0.125 / 1e6, "search": 0.01}}

# Tuning, measured with tools/search-benchmark (numbers in backend/README.md). Module constants so the benchmark can
# try variants without new settings.
# The basic tool: results come straight back, where the dynamic-filtering web_search_20260209 spends model turns
# writing filter code (p50 33 s -> 21 s on the benchmark, at more input tokens).
TOOL_TYPE = "web_search_20250305"
EFFORT = "medium"
# Similar products are extra: their own call, in parallel, on a faster model, so they never delay the exact pages.
SPLIT_SIMILAR = True
SIMILAR_MODEL = os.environ.get("SEARCH_SIMILAR_MODEL", "claude-sonnet-5-5")
SIMILAR_EFFORT = "low"
SIMILAR_SEARCHES = 4
USE_BARCODE = True
BARCODE_MODE = "evidence"     # or "search": also spend one search on brand + barcode
# Searches sent together in one step come back together: one model turn instead of one per search, so fewer seconds
# and fewer re-read tokens.
SEARCH_PLAN = ("Send your searches together in your first step, as parallel web_search calls, for example: the name "
               "and size; the name and size with three store names; the brand's own site. Then answer, searching "
               "again only if a store you need is still missing.")


class SearchError(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def domain_of(url):
    """"https://www.Example.com/x" → "example.com"."""
    m = re.match(r"^https?://([^/?#:]+)", url.strip(), re.I)
    return (m.group(1) if m else "").lower().removeprefix("www.")


def normalize_url(url):
    """Host + path without protocol, www, query, hash or trailing slash: the key for dedupe and "seen in results"."""
    m = re.match(r"^https?://([^/?#]+)([^?#]*)", url.strip(), re.I)
    if not m:
        return url.strip().lower()
    host = re.sub(r":\d+$", "", m.group(1).lower().removeprefix("www."))
    return f"{host}{m.group(2).rstrip('/')}"


def on_domain(domain, parent):
    return domain == parent or domain.endswith(f".{parent}")


def retailer_for(domain):
    return next((r for r in MX_RETAILERS if on_domain(domain, r["domain"])), None)


def slug(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def brand_domain_guesses(product):
    """Likely official domains for the brand and maker: Doritos / "Sabritas (PepsiCo México)" → doritos.com.mx, …"""
    names = [product.get("brand") or "", *re.split(r"[()]", product.get("manufacturer") or "")]
    names = [re.sub(r"\b(m[eé]xico|s\.?a\.?|de c\.?v\.?|grupo)\b", "", n, flags=re.I).strip() for n in names]
    roots = []
    for name in (n for n in names if len(n) > 1):
        s = slug(name)
        if not s:
            continue
        candidates = [s.replace("-", "")] + ([s] if "-" in s else []) + ([s.split("-")[0]] if len(s.split("-")[0]) > 2 else [])
        for c in candidates:
            if c not in roots:   # a set in the app; the API refuses a domain list with duplicates
                roots.append(c)
    return [d for r in roots[:6] for d in (f"{r}.com.mx", f"{r}.com")]


def domain_policy(product, scan_type):
    """Third party: only the retailers. Both: retailers + the brand's likely domains. First party: open minus noise."""
    if scan_type == "third_party":
        return {"allowed": list(RETAILER_SEARCH_DOMAINS)}
    if scan_type == "first_party":
        return {"blocked": list(FIRST_PARTY_BLOCKED)}
    return {"allowed": list(dict.fromkeys([*RETAILER_SEARCH_DOMAINS, *brand_domain_guesses(product)]))}


def allowed_by_policy(domain, policy):
    if "allowed" in policy:
        return any(on_domain(domain, d) for d in policy["allowed"])
    if "blocked" in policy:
        return not any(on_domain(domain, d) for d in policy["blocked"])
    return True


def max_searches(include_similar):
    return 8 if include_similar else EXACT_SEARCHES


# SEARCH_MAX_USES=4 is the fast setting: p50 14 s and US$0.25 a search, but recall 72% instead of 83%.
EXACT_SEARCHES = int(os.environ.get("SEARCH_MAX_USES", 6))


PAGE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["url", "title", "retailerName", "sourceType", "verdict", "confidence", "reason"],
    "properties": {
        "url": {"type": "string", "description": "Exact URL from the search results."},
        "title": {"type": "string", "description": "Page title as shown in the search result."},
        "retailerName": {"type": "string", "description": 'Store or brand name, e.g. "Soriana" or "Doritos (sitio oficial)".'},
        "sourceType": {"type": "string", "enum": ["first_party", "third_party"]},
        "verdict": {"type": "string", "enum": ["verified", "uncertain", "rejected"]},
        "confidence": {"type": "number", "description": "0..1 that the page sells exactly this product."},
        "reason": {"type": "string", "description": "One short English line: same brand, flavor and size?"},
    },
}

SEARCH_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["pages", "similarProducts"],
    "properties": {
        "pages": {"type": "array", "description": "Pages for the requested product.", "items": PAGE_SCHEMA},
        "similarProducts": {
            "type": "array", "description": "Similar products, only when asked. Empty otherwise.",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["brand", "productName", "variant", "relation", "reason", "pages"],
                "properties": {
                    "brand": {"type": "string"},
                    "productName": {"type": "string", "description": 'Name including brand, without the size, e.g. "Doritos Incógnita".'},
                    "variant": {"type": "string", "description": 'Flavor or variant, "" if none.'},
                    "relation": {"type": "string", "enum": ["same_brand", "competitor"]},
                    "reason": {"type": "string", "description": "One short English line on why it is similar."},
                    "pages": {"type": "array", "description": "1 or 2 product pages.", "items": PAGE_SCHEMA},
                },
            },
        },
    },
}

SEARCH_SYSTEM = """You find real product pages for one packaged retail product sold in Mexico, using the web_search tool.
Return only product detail pages: a page about this one product. Never return search results pages, category pages, store home pages, recipes, news or PDFs.
Copy each URL exactly as it appears in the search results. Never invent, guess or edit a URL; leave a store out rather than guess.
Verify each page against the product from its title and snippet:
- verified: same brand, same flavor or variant, and same size.
- uncertain: probably the same product, but the size or flavor is not shown, or the page is for a different pack size of the same product.
- rejected: a different flavor, a multipack or bundle mixed with other products, or a different product. Include at most 2 rejected near misses.
Read the size in each title and URL (56 g, 600 ml, 1 L): another number is another size, never verified. "Caja con", "paquete", "pack", "x 12", "10 pz" or a total weight means a multipack of it: rejected.
confidence is how likely it is that the page sells exactly this product. reason is one short English line.
first_party means the brand's or manufacturer's own website. third_party means a store.
When the brand is a store's own brand (for example IKEA), that store's own site is the first_party page; look for its Mexican site.
Spend your searches well: product name plus size works better than one search per store. Search for the requested product first and spend most searches on it; similar products come last.
Your final answer is only the JSON object, with no text around it."""

SCAN_TYPE_ASK = {
    "first_party": "Find only the brand's official product page (first party). Do not return store pages.",
    "third_party": "Find only Mexican store product pages (third party). Do not return the brand site.",
    "both": "Find the brand's official product page (first party) and Mexican store product pages (third party).",
}

RETRY_HINT = ("A first search found no pages. Search again more broadly: the product name without the size, the "
              "brand's own Mexican site, and the barcode if there is one. Include uncertain matches.")


SIMILAR_ASK = ("Give 2 to 4 similar products (other flavors of the same brand, and competitors) with 1 or 2 pages each, "
               "of the same kind as above.")
SIMILAR_ONLY = ("Find only similar products: 2 to 4 (other flavors or sizes of the same brand, and competitors), each "
                "with 1 or 2 product pages from the stores or brand sites. Return an empty pages list. Do one or two "
                "broad searches and pick from their results.")


def barcode_hint(barcode, brand=""):
    """How to use the barcode. The search engine matches a bare barcode poorly (random pages), so it is evidence first:
    Walmart and Bodega Aurrera URLs carry it without its check digit; BARCODE_MODE "search" also spends a search on it."""
    hint = (f"Walmart and Bodega Aurrera product URLs end with the barcode without its last digit "
            f"({walmart_code(barcode)}): such a URL is this exact product, and one ending in another number is a "
            "different item. A title or snippet showing the barcode is this exact product too.")
    if BARCODE_MODE == "search":
        hint = f"One of your searches is the brand plus the barcode ({brand} {barcode}). " + hint
    return hint


def build_prompt(request, retry=False, part="all"):
    """The user turn: the product, what to look for, where and how many searches.

    part: "all" (pages and, when asked, similar products in one call), "exact" (only the product's pages) or
    "similar" (only similar products, the call that runs next to "exact")."""
    p, scan_type = request["product"], request.get("scanType", "both")
    lines = ["Product:", f"- Brand: {p.get('brand', '')}", f"- Name: {p.get('productName', '')}"]
    for key, label in (("variant", "Flavor/variant"), ("size", "Size"), ("barcode", "Barcode (EAN/UPC)"),
                       ("manufacturer", "Manufacturer")):
        if p.get(key):
            lines.append(f"- {label}: {p[key]}")
    lines += ["", SCAN_TYPE_ASK[scan_type]]
    if scan_type != "first_party":
        stores = ", ".join(r["retailerName"] for r in MX_RETAILERS if not r["key"].endswith("-mx"))
        lines.append(f"Stores to look at: {stores}." + (" Up to one page per store." if part != "similar" else ""))
    if part == "similar":
        lines += [SIMILAR_ONLY, f"You have at most {SIMILAR_SEARCHES} searches."]
        return "\n".join(lines)
    if USE_BARCODE and ean_digits(p.get("barcode")):
        lines.append(barcode_hint(ean_digits(p.get("barcode")), p.get("brand", "")))
    similar = request.get("includeSimilar") and part == "all"
    lines.append(f"Also {SIMILAR_ASK[0].lower()}{SIMILAR_ASK[1:]}" if similar else "Return an empty similarProducts list.")
    lines.append(f"You have at most {max_searches(similar)} searches.")
    if SEARCH_PLAN:
        lines.append(SEARCH_PLAN)
    if retry:
        lines.append(RETRY_HINT)
    return "\n".join(lines)


def ean_digits(barcode):
    """The barcode's digits when it looks like an EAN-8/UPC-A/EAN-13/GTIN-14, else None."""
    digits = re.sub(r"\D", "", str(barcode or ""))
    return digits if len(digits) in (8, 12, 13, 14) else None


def walmart_code(barcode):
    """Walmart México's item code in its URLs: the GTIN without its check digit, zero-padded to 14 (7501030424536 →
    00750103042453)."""
    return barcode[:-1].zfill(14)


def barcode_evidence(url, title, barcode):
    """"match" when the page's URL or title carries this barcode, "other" when a Walmart-family URL carries another
    product's code (a different item), else None."""
    barcode = ean_digits(barcode)
    if not barcode:
        return None
    core = barcode.lstrip("0")
    text = f"{url} {title or ''}"
    numbers = [n.lstrip("0") for n in re.findall(r"\d{7,14}", text)]
    if core in numbers or core[:-1] in numbers:
        return "match"
    domain = domain_of(url)
    if any(on_domain(domain, d) for d in ("walmart.com.mx", "bodegaaurrera.com.mx")):
        m = re.search(r"/(\d{13,14})(?:[/?#]|$)", url)
        if m and m.group(1).lstrip("0") not in (core, core[:-1]):
            return "other"
    return None


def collect_seen_urls(content):
    """Every URL that came back from a search tool result (or a text citation) anywhere in the content."""
    seen = set()

    def walk(v, in_result):
        if isinstance(v, str):
            # Dynamic filtering can hand results back as code output text.
            if in_result:
                seen.update(normalize_url(m) for m in re.findall(r"https?://[^\s\"'<>)\]]+", v))
            return
        if isinstance(v, list):
            for item in v:
                walk(item, in_result)
            return
        if not isinstance(v, dict):
            return
        kind = v.get("type")
        is_result = in_result or (isinstance(kind, str) and (kind.endswith("_tool_result") or kind.endswith("_result_location")))
        if is_result and isinstance(v.get("url"), str):
            seen.add(normalize_url(v["url"]))
        for k, child in v.items():
            if k != "url":
                walk(child, is_result or k == "citations")

    walk(content, False)
    return seen


def answer_text(content):
    """The final answer text: text blocks after the last tool activity (or all text when there is none)."""
    blocks = [b if isinstance(b, dict) else {} for b in content]
    start = 0
    for i, b in enumerate(blocks):
        if isinstance(b.get("type"), str) and b["type"] not in ("text", "thinking", "redacted_thinking"):
            start = i + 1
    pick = lambda frm: "".join(b["text"] for b in blocks[frm:] if b.get("type") == "text" and isinstance(b.get("text"), str)).strip()
    return pick(start) or pick(0)


def extract_json(text):
    """json.loads, tolerating a code fence or words around the object (when structured output is off)."""
    t = re.sub(r"\s*```$", "", re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.I))
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        first, last = t.find("{"), t.rfind("}")
        if first >= 0 and last > first:
            try:
                return json.loads(t[first:last + 1])
            except json.JSONDecodeError:
                pass
    raise SearchError("The search returned an answer the backend could not read", "invalid_output")


def _str(v):
    return v.strip() or None if isinstance(v, str) else None


def _clamp01(v):
    n = v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.5
    n = n / 100 if 1 < n <= 100 else n
    return min(1, max(0, n))


SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kg|kilos?|g|gr|grs|gramos|ml|mililitros|l|lt|lts|litros?)(?![a-z])", re.I)
SIZE_UNIT = {"kg": ("g", 1000), "kilo": ("g", 1000), "kilos": ("g", 1000), "g": ("g", 1), "gr": ("g", 1),
             "grs": ("g", 1), "gramos": ("g", 1), "ml": ("ml", 1), "mililitros": ("ml", 1), "l": ("ml", 1000),
             "lt": ("ml", 1000), "lts": ("ml", 1000), "litro": ("ml", 1000), "litros": ("ml", 1000)}


def sizes_in(text):
    """Net contents named in a text, normalized: "Coca-Cola 600 ml" → {("ml", 600.0)}; "1.5 L" → {("ml", 1500.0)}."""
    out = set()
    for number, unit in SIZE_RE.findall(text or ""):
        base, factor = SIZE_UNIT[unit.lower()]
        out.add((base, round(float(number.replace(",", ".")) * factor, 1)))
    return out


def size_conflict(text, size):
    """The size a title names when it names sizes of the product's kind and none is the product's size, else None."""
    wanted = sizes_in(size)
    if len(wanted) != 1:
        return None
    (unit, amount), = wanted
    named = [s for s in sizes_in(text) if s[0] == unit]
    if not named or any(abs(a - amount) <= max(1.0, amount * 0.02) for _, a in named):
        return None
    shown = sorted(named, key=lambda s: s[1])[0][1]
    return f"{shown:g} {unit}"


def to_page(raw, ctx, match_type, similar_product_id=None):
    if not isinstance(raw, dict):
        return None
    url = _str(raw.get("url"))
    if not url or not re.match(r"^https?://[^\s/?#]+\.[^\s/?#]+", url, re.I):
        return None
    domain = domain_of(url)
    if not allowed_by_policy(domain, ctx["policy"]):
        return None
    # The domain decides the type: a known store is third party; anything else must be the brand's own site.
    retailer = retailer_for(domain)
    if not retailer and raw.get("sourceType") == "third_party":
        return None
    source_type = "third_party" if retailer else "first_party"
    scan_type = ctx["request"].get("scanType", "both")
    if scan_type != "both" and scan_type != source_type:
        return None

    status = raw.get("verdict") if raw.get("verdict") in VERDICTS else "uncertain"
    confidence = _clamp01(raw.get("confidence"))
    reason = _str(raw.get("reason")) or ("Same brand, flavor and size" if status == "verified" else "Not confirmed on the page")
    unseen = ctx["seen"] and normalize_url(url) not in ctx["seen"]
    evidence = barcode_evidence(url, raw.get("title"), ctx["request"]["product"].get("barcode")) if match_type == "exact" else None
    if evidence == "match" and not unseen:
        # The barcode itself is on the page (or in its URL): the strongest sign it is this exact product.
        if status != "verified":
            reason = f"Barcode matches. {reason}"
        status, confidence = "verified", max(confidence, 0.95)
    elif evidence == "other" and status == "verified":
        status, confidence = "uncertain", min(confidence, 0.5)
        reason = f"The store's item code is another barcode. {reason}"
    elif match_type == "exact" and status == "verified" and (
            other := size_conflict(raw.get("title"), ctx["request"]["product"].get("size"))):
        status, confidence = "uncertain", min(confidence, 0.5)
        reason = f"The title says {other}. {reason}"
    if unseen:
        # Claude named a URL the search never returned: keep it, but don't call it verified.
        status = "uncertain" if status == "verified" else status
        confidence = min(confidence, 0.5)
        reason = f"Not seen in search results. {reason}"
    page = {"url": url, "domain": domain,
            "retailerName": retailer["retailerName"] if retailer else _str(raw.get("retailerName"))
            or f"{ctx['request']['product'].get('brand')} (official site)",
            "sourceType": source_type, "title": _str(raw.get("title")) or url, "matchType": match_type,
            "verification": {"status": status, "confidence": confidence, "reason": reason}}
    if similar_product_id:
        page["similarProductId"] = similar_product_id
    return page


def _rank(p):
    return (p["matchType"] != "exact", p["sourceType"] != "first_party", STATUS_RANK[p["verification"]["status"]],
            -p["verification"]["confidence"])


def _dedupe(pages):
    """Same URL twice: keep the better-ranked copy."""
    out = {}
    for p in sorted(pages, key=_rank):
        out.setdefault(normalize_url(p["url"]), p)
    return list(out.values())


def parse_answer(raw, request, seen=frozenset()):
    """Validate Claude's JSON object into pages and similar products, ranked. Raises SearchError."""
    if not isinstance(raw, dict):
        raise SearchError("The search returned no data", "invalid_output")
    if not isinstance(raw.get("pages"), list):
        raise SearchError("The search returned an answer the backend could not read", "invalid_output")
    product = request["product"]
    ctx = {"request": request, "policy": domain_policy(product, request.get("scanType", "both")), "seen": seen}
    exact = _dedupe([p for p in (to_page(x, ctx, "exact") for x in raw["pages"]) if p])[:LIMITS["exactPages"]]

    similar_products, similar_pages = [], []
    main_id = slug(f"{product.get('productName', '')} {product.get('variant') or ''}")
    if request.get("includeSimilar") and isinstance(raw.get("similarProducts"), list):
        for sp in raw["similarProducts"]:
            if len(similar_products) >= LIMITS["similarProducts"]:
                break
            if not isinstance(sp, dict):
                continue
            brand, name, variant = _str(sp.get("brand")), _str(sp.get("productName")), _str(sp.get("variant"))
            if not brand or not name:
                continue
            key = slug(f"{name} {variant or ''}")
            sid = f"similar-{key}"
            if key == main_id or any(s["id"] == sid for s in similar_products):
                continue
            relation = sp.get("relation") if sp.get("relation") in ("same_brand", "competitor") else (
                "same_brand" if brand.lower() == (product.get("brand") or "").lower() else "competitor")
            similar_products.append({"id": sid, "brand": brand, "productName": name, "relation": relation,
                                     "reason": _str(sp.get("reason")) or "Similar product",
                                     **({"variant": variant} if variant else {})})
            pages = [p for p in (to_page(x, ctx, "similar", sid) for x in sp.get("pages") or []) if p]
            similar_pages += _dedupe(pages)[:LIMITS["pagesPerSimilar"]]

    exact_urls = {normalize_url(p["url"]) for p in exact}
    pages = sorted(exact + [p for p in _dedupe(similar_pages) if normalize_url(p["url"]) not in exact_urls], key=_rank)
    if not pages:
        raise SearchError(f"No store pages found for {product.get('productName')}. Check the name and size, then try again.",
                          "no_results")
    return {"pages": pages, "similarProducts": similar_products}


def read_response(response):
    """Check stop_reason and read the final JSON answer: (raw object, URLs the search returned). Raises SearchError."""
    stop = response.get("stop_reason")
    if stop == "refusal":
        raise SearchError("Claude declined to search for this product", "refusal")
    if stop == "max_tokens":
        raise SearchError("The search answer was cut off", "truncated")
    if stop == "pause_turn":
        raise SearchError("The search did not finish in time. Try again.", "incomplete")
    content = response.get("content") or []
    text = answer_text(content)
    if not text:
        raise SearchError("The search returned no answer", "invalid_output")
    return extract_json(text), collect_seen_urls(content)


def parse_response(response, request):
    """Check stop_reason, read the final JSON answer and validate it. Raises SearchError."""
    raw, seen = read_response(response)
    return parse_answer(raw, request, seen)


# --- the API call ---------------------------------------------------------------------------------------------
class ClaudeSearch:
    """`search(product, request)` → found pages (search.py's shape) plus `run`, the raw record. Raises SearchError.

    With includeSimilar the exact pages and the similar products are two calls run side by side (SPLIT_SIMILAR):
    the similar call is on a faster model and may fail or run late without costing the exact pages anything."""

    MAX_CONTINUATIONS = 2

    def __init__(self, config, post=None):
        self.config = config
        self.post = post or self._post
        self.structured = True   # off for the process if the API refuses structured output next to web search

    def __call__(self, product, request=None):
        request = {"scanType": "both", "includeSimilar": False, **(request or {}), "product": product}
        started, attempts = time.time(), []
        split = SPLIT_SIMILAR and request.get("includeSimilar")
        similar = {}
        if split:
            worker = threading.Thread(target=self._similar, args=(request, started, similar), daemon=True)
            worker.start()
        try:
            raw, seen = self._exact(request, started, attempts, "exact" if split else "all")
            if split:
                # The exact pages are in; similar products get what is left of the deadline, at most 30 s more.
                worker.join(max(0.0, min(self.config.search_timeout - (time.time() - started), 30.0)))
                if similar.get("attempt"):
                    attempts.append(similar["attempt"])
                if similar.get("raw"):
                    raw = {**raw, "similarProducts": similar["raw"].get("similarProducts") or []}
                    seen = seen | similar["seen"]
            found = parse_answer(raw, request, seen)
        except SearchError as exc:
            exc.run = self._run(attempts, started, error=str(exc))
            raise
        found["recordedBy"] = f"Claude web search ({self.config.search_model}" + (
            ", retried" if any(a["retry"] for a in attempts) else "") + ")"
        found["run"] = self._run(attempts, started, similar_error=similar.get("error"))
        return found

    def _exact(self, request, started, attempts, part):
        """The product's pages (and similar products when not split); an empty answer is retried once."""
        for retry in (False, True):
            response, usage = self._ask(request, retry, started, part)
            attempts.append({"retry": retry, "part": part, "model": self.config.search_model,
                             "stop_reason": response.get("stop_reason"), "content": response.get("content"), "usage": usage})
            raw, seen = read_response(response)
            try:
                parse_answer(raw, {**request, "includeSimilar": part == "all" and request.get("includeSimilar")}, seen)
                return raw, seen
            except SearchError as exc:
                if exc.code != "no_results" or retry:
                    raise
        raise AssertionError("unreachable")

    def _similar(self, request, started, out):
        """The similar-products call (thread): fills `out` with raw, seen, attempt or error; never raises."""
        try:
            response, usage = self._ask(request, False, started, "similar")
            out["attempt"] = {"retry": False, "part": "similar", "model": SIMILAR_MODEL,
                              "stop_reason": response.get("stop_reason"), "content": response.get("content"), "usage": usage}
            out["raw"], out["seen"] = read_response(response)
        except SearchError as exc:
            out["error"] = str(exc)
        except Exception as exc:  # noqa: BLE001 - similar products are extra; the exact pages still go out
            out["error"] = f"{type(exc).__name__}: {exc}"

    def _run(self, attempts, started, error=None, similar_error=None):
        keys = ("input", "output", "cacheRead", "cacheWrite", "searches")
        totals = {k: sum(a["usage"][k] for a in attempts) for k in keys}
        usd = 0.0
        for a in attempts:
            price = PRICES.get(a.get("model") or self.config.search_model, PRICE)
            usd += sum(a["usage"][k] * price[k if k != "searches" else "search"] for k in keys)
        run = {"model": self.config.search_model, "seconds": round(time.time() - started, 1), "usage": totals,
               "usd": round(usd, 4), "error": error, "attempts": attempts}
        if similar_error:
            run["similarError"] = similar_error
        return run

    def _ask(self, request, retry, started, part="all"):
        policy = domain_policy(request["product"], request.get("scanType", "both"))
        similar_call = part == "similar"
        uses = SIMILAR_SEARCHES if similar_call else max_searches(part == "all" and request.get("includeSimilar"))
        tool = {"type": TOOL_TYPE, "name": "web_search", "max_uses": uses,
                "user_location": {"type": "approximate", "country": "MX", "timezone": "America/Mexico_City"}}
        tool.update({"allowed_domains": policy["allowed"]} if "allowed" in policy else {"blocked_domains": policy["blocked"]})
        messages = [{"role": "user", "content": build_prompt(request, retry, part)}]
        model = SIMILAR_MODEL if similar_call else self.config.search_model
        effort = SIMILAR_EFFORT if similar_call else EFFORT
        content, usage = [], {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "searches": 0}
        response = {}
        for _ in range(self.MAX_CONTINUATIONS + 1):
            response = self._create(messages, [tool], started, model, effort)
            content += response.get("content") or []
            u = response.get("usage") or {}
            usage["input"] += u.get("input_tokens") or 0
            usage["output"] += u.get("output_tokens") or 0
            usage["cacheRead"] += u.get("cache_read_input_tokens") or 0
            usage["cacheWrite"] += u.get("cache_creation_input_tokens") or 0
            usage["searches"] += (u.get("server_tool_use") or {}).get("web_search_requests") or 0
            if response.get("stop_reason") != "pause_turn":
                break
            # The server paused its tool loop: send the turn back unchanged and it resumes.
            messages.append({"role": "assistant", "content": response.get("content") or []})
        return {**response, "content": content}, usage

    def _create(self, messages, tools, started, model=None, effort=None):
        model, effort = model or self.config.search_model, effort or EFFORT
        body = {"model": model, "max_tokens": 16000, "system": SEARCH_SYSTEM, "tools": tools, "messages": messages}
        if model in ("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"):
            # Server-side refusal fallback: a declined request is retried on a model chosen by the API.
            body["fallbacks"] = "default"
        timeout = max(5, self.config.search_timeout - (time.time() - started))
        if self.structured:
            try:
                return self.post({**body, "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": SEARCH_SCHEMA}}}, timeout)
            except SearchError as exc:
                # Fallback for an API that refuses structured output alongside web search: plain JSON, parsed strictly.
                if exc.code != "bad_request" or not re.search(r"output_config|format|citation", str(exc), re.I):
                    raise
                self.structured = False
        return self.post({**body, "output_config": {"effort": effort}}, timeout)

    def _post(self, body, timeout):
        key = self.config.anthropic_key
        if not key:
            raise SearchError("SEARCH=claude needs ANTHROPIC_API_KEY in the backend's environment", "not_configured")
        request = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), method="POST",
                                         headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                  "anthropic-beta": "server-side-fallback-2026-07-01",
                                                  "content-type": "application/json"})
        started = time.time()
        for attempt in (1, 2):
            try:
                return self._send(request, timeout - (time.time() - started))
            except SearchError as exc:
                # A connection cut mid-answer (IncompleteRead, reset) is the network: one retry within the deadline.
                if exc.code != "transport":
                    raise
                if attempt == 2 or timeout - (time.time() - started) < 20:
                    raise SearchError(f"The connection to Claude broke off; try again ({exc})", "unreachable") from None

    def _send(self, request, timeout):
        try:
            with urllib.request.urlopen(request, timeout=max(5, timeout)) as response:
                return json.loads(response.read().decode("utf-8"))
        except (http.client.IncompleteRead, http.client.RemoteDisconnected, ConnectionResetError) as exc:
            raise SearchError(type(exc).__name__, "transport") from None
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:400].decode("utf-8", "replace")
            if exc.code == 400:
                raise SearchError(f"Claude rejected the search request: {detail}", "bad_request") from None
            if exc.code == 401:
                raise SearchError("Live search is not set up: the Claude API key was rejected", "auth") from None
            if exc.code == 429:
                raise SearchError("Live search is busy (rate limited). Wait a minute and try again.", "rate_limited") from None
            raise SearchError(f"Live search failed ({exc.code}): {detail}", "api_error") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SearchError(f"Could not reach Claude: {getattr(exc, 'reason', exc)}", "unreachable") from None


# --- the link check (search.py's verify step) -----------------------------------------------------------------
LINK_TIMEOUT = 4.0
LINK_USER_AGENT = "ProductScannerKit/0.1 (+link check)"


def fetch_head(url, timeout=LINK_TIMEOUT):
    """One GET of a page, for the link check: {"code", "final", "title"}; network trouble gives code None."""
    request = urllib.request.Request(url, headers={"User-Agent": LINK_USER_AGENT, "Accept-Language": "es-MX,es;q=0.9"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(200_000).decode("utf-8", "replace")
            title = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
            return {"code": response.status, "final": response.geturl(),
                    "title": re.sub(r"\s+", " ", title.group(1)).strip()[:200] if title else ""}
    except urllib.error.HTTPError as exc:
        return {"code": exc.code, "final": url, "title": ""}
    except Exception:  # noqa: BLE001 - timeouts, TLS, DNS: unknown, the page is kept as it is
        return {"code": None, "final": url, "title": ""}


def link_verdict(page, fetched, product):
    """"dead" (404/410, or sent to a home or search page), "other_size" (the live title names another size), else None."""
    code, final = fetched.get("code"), fetched.get("final") or page["url"]
    if code in (404, 410):
        return "dead"
    if code and 200 <= code < 300:
        path = re.sub(r"^https?://[^/]+", "", final)
        if normalize_url(final) != normalize_url(page["url"]) and (
                path.strip("/") in ("", "es", "mx", "es-mx", "es/mx", "mx/es")
                or re.search(r"/(search|busca|busqueda|s)(/|\?|$)|[?&](q|k|text)=", path, re.I)):
            return "dead"
        if page.get("matchType", "exact") == "exact" and size_conflict(fetched.get("title"), product.get("size")):
            return "other_size"
    return None


def check_links(pages, product, may_fetch=lambda page: True, fetch=fetch_head, workers=8):
    """Drop dead links and downgrade a verified page whose live title names another size. Pages `may_fetch` refuses
    (robots) and pages that block or time out are kept unchanged. Returns (pages, {"dead": n, "otherSize": n})."""
    targets = [p for p in pages if may_fetch(p)]
    results = {}
    if targets:
        with concurrent.futures.ThreadPoolExecutor(min(workers, len(targets))) as pool:
            for page, fetched in zip(targets, pool.map(lambda p: fetch(p["url"]), targets)):
                results[id(page)] = fetched
    kept, counts = [], {"dead": 0, "otherSize": 0}
    for page in pages:
        fetched = results.get(id(page))
        verdict = link_verdict(page, fetched, product) if fetched else None
        if verdict == "dead":
            counts["dead"] += 1
            continue
        if verdict == "other_size":
            counts["otherSize"] += 1
            v = page["verification"]
            if v["status"] == "verified":
                other = size_conflict(fetched["title"], product.get("size"))
                page = {**page, "verification": {"status": "uncertain", "confidence": min(v["confidence"], 0.5),
                                                 "reason": f"The page title says {other}. {v['reason']}"}}
        kept.append(page)
    return kept, counts
