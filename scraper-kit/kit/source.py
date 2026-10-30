"""Sources: one module per site in `sources/`, found by file name. Adding a site edits no shared file.

A module is pure: it builds requests and parses saved responses. It makes no network request and reads no
file, so `kit.capture.replay` can rebuild its rows from a saved capture, offline, in a test.

A module declares:

    SOURCE = "barcel_mx"                  # [a-z][a-z0-9_]*, unique; the file is sources/<SOURCE>.py
    ORIGIN = "https://www.barcel.com.mx"  # bare https origin; every request stays on it
    RETAILER = "Barcel"                   # the name the app shows
    KIND = "first_party"                  # "first_party" (the brand's own site) or "third_party"
    BRANDS = ("Barcel", "Takis")          # first_party: the brands the site sells as their owner
    INTERVAL = 2                          # seconds between request starts, at least 1
    CURRENCY = "MXN"                      # optional: the currency when the site does not state one
    REPEATED_REQUESTS_OK = False          # optional: skip a discovery request asked for again (linked pages)

    SAMPLE_PAGE = "https://..."           # page-only sources: a product page the live gate reads

    def seeds(): ...                      # the first discovery requests
    def discover(response, request): ...  # (items, more_requests) or (items, [], bound)
    def check_detail(response, item): ... # raise ValueError unless the detail is that item
    def listings(capture): ...            # the rows (kit.rows) of a capture
    def page(response): ...               # optional: rows of one product page fetched by URL (`kit page`)
    def page_request(url): ...            # optional: the request `page` reads for a product page URL (default:
                                          # the URL itself; VTEX reads the site's own product JSON instead)
    def item_key(item_id): ...            # optional: the row's native_id for a discovered item (default: the id)

A request is `{"url": str}`, plus `"json": {...}` or `"form": {...}` for a POST. A response is the saved dict:
`url`, `final_url`, `status`, `sha256`, `observed_at`, `headers`, `body` (text) and `request` for a POST.

`discover` returns `items`, one `{"id": str, "request": request or None}` per record on the page (None: the
listing is the record and no detail is fetched), and `more_requests` (the next page; empty ends that branch).
Discovery is complete when no request is left. A request asked for twice fails the capture, because it means
pagination loops. A source that stops at its own limit returns a third value naming it, such as "10 pages".
`discover` raises ValueError when the response is not the expected document (an error page with status 200).

The generic sources in `kit/generic/` (Shopify, VTEX, Drupal JSON:API, JSON-LD sitemap, Open Graph sitemap) give
a module all of these functions from one `bind(...)` call, so most sites are a few lines.

Scope by kind: a first_party source covers the brand's whole catalog (the next scan of that brand needs no build);
a third_party source reads the one product page it is given (`page`, `page_request`), never the retailer's catalog.
"""
import ast
import importlib
import inspect
import pkgutil
import re
from pathlib import Path
from urllib.parse import urlsplit

KINDS = ("first_party", "third_party")
ROOT = Path(__file__).resolve().parents[1]
DECLARED = ("SOURCE", "ORIGIN", "RETAILER", "KIND", "INTERVAL", "ALIASES")


def declared(path):
    """A source file's top-level constants, read from its text without running it (the gate never imports the
    source it judges). A constant that is not a literal reads as None."""
    found = {}
    for node in ast.parse(Path(path).read_text(encoding="utf-8")).body:
        for target in node.targets if isinstance(node, ast.Assign) else []:
            if isinstance(target, ast.Name) and target.id in DECLARED:
                try:
                    found[target.id] = ast.literal_eval(node.value)
                except (ValueError, TypeError, SyntaxError, RecursionError):
                    found[target.id] = None
    return found


def check_source(module):
    """Refuse a module that does not follow the interface above."""
    label = getattr(module, "__name__", "source")
    source = getattr(module, "SOURCE", None)
    if not isinstance(source, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", source):
        raise ValueError(f"{label}: SOURCE must match [a-z][a-z0-9_]*")
    url = urlsplit(getattr(module, "ORIGIN", None) or "")
    bare = url.hostname and not (url.username or url.password or url.path or url.query or url.fragment)
    # Plain http is accepted for the loopback address only, which the tests use.
    if not bare or not (url.scheme == "https" or (url.scheme == "http" and url.hostname == "127.0.0.1")):
        raise ValueError(f"{label}: ORIGIN must be a bare https origin")
    if not isinstance(getattr(module, "RETAILER", None), str) or not module.RETAILER.strip():
        raise ValueError(f"{label}: RETAILER must name the site")
    if getattr(module, "KIND", None) not in KINDS:
        raise ValueError(f"{label}: KIND must be one of {', '.join(KINDS)}")
    aliases = getattr(module, "ALIASES", ())
    if not isinstance(aliases, tuple) or any(not isinstance(a, str) or not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", a)
                                             for a in aliases):
        raise ValueError(f"{label}: ALIASES must be a tuple of host names that redirect to ORIGIN")
    brands = getattr(module, "BRANDS", ())
    if not isinstance(brands, tuple) or any(not isinstance(b, str) or not b for b in brands):
        raise ValueError(f"{label}: BRANDS must be a tuple of names")
    if module.KIND == "first_party" and not brands:
        raise ValueError(f"{label}: a first_party source names its BRANDS")
    interval = getattr(module, "INTERVAL", None)
    if type(interval) not in (int, float) or not 1 <= interval < float("inf"):
        raise ValueError(f"{label}: INTERVAL must be a number of seconds, at least 1")
    currency = getattr(module, "CURRENCY", None)
    if currency is not None and not (isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency)):
        raise ValueError(f"{label}: CURRENCY must be an ISO 4217 code")
    if type(getattr(module, "REPEATED_REQUESTS_OK", False)) is not bool:
        raise ValueError(f"{label}: REPEATED_REQUESTS_OK must be True or False")
    catalog = [name for name in ("seeds", "discover", "listings") if callable(getattr(module, name, None))]
    if catalog and len(catalog) < 3:
        raise ValueError(f"{label}: a catalog source defines seeds(), discover() and listings()")
    if not catalog and not callable(getattr(module, "page", None)):
        raise ValueError(f"{label}: define seeds(), discover() and listings(), or page() for a page-only source")
    if catalog and inspect.signature(module.seeds).parameters:
        raise ValueError(f"{label}: seeds() takes no parameter")
    if not catalog and not str(getattr(module, "SAMPLE_PAGE", "")).startswith(module.ORIGIN + "/"):
        raise ValueError(f"{label}: a page-only source names a SAMPLE_PAGE on its ORIGIN, for the live gate")
    if module.KIND == "first_party" and not catalog:
        raise ValueError(f"{label}: a first_party source covers the brand's catalog (seeds, discover, listings)")
    return module


def load(folder=None, package="sources"):
    """Every source in `folder` (default: sources/), by SOURCE. A file named `_*.py` is shared code."""
    folder = Path(folder) if folder else ROOT / package
    found = {}
    for info in pkgutil.iter_modules([str(folder)]):
        if info.name.startswith("_"):
            continue
        module = check_source(importlib.import_module(f"{package}.{info.name}"))
        if module.SOURCE != info.name:
            raise ValueError(f"{module.__name__}: SOURCE must equal the file name")
        if module.SOURCE in found:
            raise ValueError(f"{module.__name__}: SOURCE is already used")
        found[module.SOURCE] = module
    return found


def host(module):
    return urlsplit(module.ORIGIN).hostname


def hosts(module):
    """ORIGIN's host and the ALIASES that redirect to it (super.walmart.com.mx for walmart_mx), www. ignored."""
    return {h.removeprefix("www.") for h in (host(module), *getattr(module, "ALIASES", ()))}


def for_url(sources, url):
    """The sources whose origin, or one of its aliases, serves `url` (www. ignored)."""
    wanted = (urlsplit(url).hostname or "").removeprefix("www.")
    return [m for m in sources.values() if wanted in hosts(m)]


def on_origin(module, url):
    """`url` with an alias host swapped for ORIGIN (same path and query), since every request stays on ORIGIN."""
    part = urlsplit(url)
    if (part.hostname or "").removeprefix("www.") == host(module).removeprefix("www."):
        return url
    return module.ORIGIN + (part.path or "/") + (f"?{part.query}" if part.query else "")
