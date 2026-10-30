"""Which generic reader fits a site, decided from a few requests, and the source file it needs.

1. robots.txt (kit.robots.access): is the page allowed for us and for AI agents, and which sitemaps does it name;
2. `/products.json?limit=1`: a Shopify store answers with a `products` list;
3. a `/<slug>/p` page: a VTEX store answers its own catalog JSON for that slug;
4. `/jsonapi`: a Drupal site with JSON:API open lists its node types;
5. the product page itself: a JSON-LD Product, else Open Graph tags with a price;
6. nothing fits: the site needs a hand-written source (a Devin build).

`probe` returns a report; `source_text` writes the source file for a generic fit. A person or Devin still sets
KIND, BRANDS and, for a sitemap or JSON:API reader, the product pattern, and saves a fixture before it merges.
"""
import re
from urllib.parse import urljoin, urlsplit

from . import robots
from .generic import markup, vtex
from .generic import page as generic_page
from .http import Http, Refused


def _try(report, label, call):
    try:
        return call()
    except (Refused, ValueError, OSError) as exc:
        report["notes"].append(f"{label}: {exc}")
        return None


def probe(url, *, fetch=None):
    part = urlsplit(url)
    origin = f"{part.scheme}://{part.netloc}"
    fetch = fetch or Http(origin, 1)
    report = {"url": url, "origin": origin, "host": part.hostname, "access": None, "sitemaps": [],
              "platform": None, "reader": None, "row": None, "notes": []}
    report["access"] = fetch.access(url) if hasattr(fetch, "access") else {"status": "allowed", "code": "not_checked"}
    if fetch.robots is not None and 200 <= fetch.robots["status"] < 300:
        # A robots.txt may name a sitemap by path (Office Depot: /officedepot/en/sitemap.xml).
        report["sitemaps"] = [urljoin(origin + "/", s) for s in robots.sitemaps(fetch.robots["body"])]
    if report["access"]["status"] != "allowed":
        report["notes"].append(f"{report['access']['reason']}: no scraper; link out, or use an official API")
        return report

    shop = _try(report, "products.json", lambda: fetch({"url": origin + "/products.json?limit=1"}))
    if shop and shop["status"] == 200 and '"products"' in shop["body"][:200]:
        report["platform"] = report["reader"] = "shopify"

    if report["reader"] is None and part.path.rstrip("/").endswith("/p"):
        page_request, read = vtex.bind(origin, "MXN")
        api = _try(report, "vtex", lambda: fetch(page_request(url)))
        if api and api["status"] == 200 and api["body"].lstrip().startswith("[") and '"productId"' in api["body"]:
            report["platform"] = report["reader"] = "vtex"
            report["row"] = _try(report, "vtex rows", lambda: read(api)[0])
            _missing(report)
            return report

    if report["reader"] is None:
        index = _try(report, "jsonapi", lambda: fetch({"url": origin + "/jsonapi"}))
        if index and index["status"] == 200 and '"node--' in index["body"]:
            types = sorted(set(re.findall(r'"node--([a-z0-9_]+)"', index["body"])))
            report["platform"], report["reader"], report["jsonapi_node_types"] = "drupal", "jsonapi", types
            report["notes"].append(f"Drupal JSON:API is open; node types {types}: pick the product type")

    response = _try(report, "page", lambda: fetch({"url": url}))
    if response is not None and response["status"] != 200:
        report["notes"].append(f"the page answered {response['status']}")
    elif response is not None:
        row = _try(report, "page", lambda: generic_page.read(response)[0])
        if row:
            report["row"] = row
            report["reader"] = report["reader"] or row["fields"]["reader"]
            report["platform"] = report["platform"] or row["fields"]["reader"]
    if report["reader"] is None:
        report["notes"].append("no generic reader fits: build a source (Devin skill build-source)")
    _missing(report)
    return report


def _missing(report):
    """What the reader's row lacks, so a builder knows what to look for elsewhere on the page."""
    row = report.get("row")
    if row:
        report["missing"] = [k for k in ("title", "price", "brand", "barcode", "image_url") if not row.get(k)]


def source_text(report, source, retailer, kind, brands=(), currency="MXN", product_path=None, node_type=None):
    """The text of sources/<source>.py for a generic fit."""
    reader = report["reader"]
    if reader not in ("shopify", "vtex", "jsonapi", "jsonld", "open_graph"):
        raise ValueError("no generic reader fits this site")
    module = {"shopify": "shopify", "vtex": "vtex", "jsonapi": "jsonapi", "jsonld": "jsonld", "open_graph": "og"}[reader]
    head = [f'"""{retailer} ({report["host"]}): generic {reader} reader, from `kit probe {report["url"]}`."""',
            f"from kit.generic import {module}", "", f'SOURCE = "{source}"', f'ORIGIN = "{report["origin"]}"',
            f'RETAILER = "{retailer}"', f'KIND = "{kind}"', f"BRANDS = {tuple(brands)!r}", "INTERVAL = 2",
            f'CURRENCY = "{currency}"']
    if reader == "vtex":
        head += [f'SAMPLE_PAGE = "{report["url"]}"', "", "page_request, page = vtex.bind(ORIGIN, CURRENCY)"]
    elif kind == "third_party":
        # A retailer is read one product page at a time, never as a catalog.
        head[1] = "from kit.generic import page as generic_page"
        head += [f'SAMPLE_PAGE = "{report["url"]}"', "", "", "def page(response):",
                 "    return generic_page.read(response, CURRENCY)"]
    elif reader == "shopify":
        head += ["", "seeds, discover, check_detail, listings, page = shopify.bind(ORIGIN, CURRENCY)"]
    elif reader == "jsonapi":
        chosen = node_type or next((t for t in report.get("jsonapi_node_types", []) if "product" in t), None)
        if not chosen:
            raise ValueError("pick the product node type (--node-type)")
        head += ["", f'seeds, discover, check_detail, listings, page = jsonapi.bind(ORIGIN, "{chosen}", "field_marca")']
    else:
        sitemap = urlsplit(report["sitemaps"][0]).path if report["sitemaps"] else "/sitemap.xml"
        pattern = product_path or markup.path_of(report["url"]).rsplit("/", 1)[0] + "/[^/]+/?"
        head += ["", f'seeds, discover, check_detail, listings, page = {module}.bind(ORIGIN, "{sitemap}", '
                     f'r"{pattern}", CURRENCY)']
    return "\n".join(head) + "\n"
