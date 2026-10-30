"""Collect a source into a capture, and replay a saved capture into rows without the network.

A capture is one JSON document holding every response the run saw, in order:

    {"format": "kit-capture-v1", "source", "origin", "mode": "catalog" | "page", "started_at", "finished_at",
     "user_agent", "robots": response or None, "pages": [response, ...], "details": [response + item_id, ...],
     "status": {"items", "details", "rows", "bounds": [...], "complete": bool}}

`replay` is how a source is tested: it walks the saved pages again through the module's own `discover`, checks
that each saved page is the request discovery asks for next, checks each detail with `check_detail`, and builds
the rows. A parser change that alters what a saved
capture yields fails there, offline, before it reaches the app.
"""
import json
from pathlib import Path

from . import rows as kit_rows
from .http import Http, utc

FORMAT = "kit-capture-v1"


def _key(request):
    return json.dumps(request, sort_keys=True, ensure_ascii=False)


def _discovered(module, result, request):
    if not isinstance(result, tuple) or len(result) not in (2, 3):
        raise ValueError(f"{module.SOURCE}: discover returns (items, more) or (items, [], bound)")
    items, more = result[0], result[1]
    bound = result[2] if len(result) == 3 else None
    if bound is not None and (more or not isinstance(bound, str) or not bound):
        raise ValueError(f"{module.SOURCE}: a bound is text and ends its branch")
    for item in items:
        if not isinstance(item, dict) or set(item) != {"id", "request"} or not isinstance(item["id"], str):
            raise ValueError(f"{module.SOURCE}: an item is {{id: str, request: request or None}}, got {item!r}")
    for nxt in more:
        if not isinstance(nxt, dict) or not isinstance(nxt.get("url"), str):
            raise ValueError(f"{module.SOURCE}: a request is {{url: str, ...}}, got {nxt!r}")
    return items, more, bound


class _Walk:
    """Discovery state: the queue, the requests already made, and the items found."""

    def __init__(self, module):
        self.module, self.queue, self.made, self.items, self.bounds = module, list(module.seeds()), set(), {}, []
        _discovered(module, ([], self.queue), None)

    def done(self):
        return not self.queue

    def take(self):
        request = self.queue.pop(0)
        self.made.add(_key(request))
        return request

    def add(self, response, request):
        items, more, bound = _discovered(self.module, self.module.discover(response, request), request)
        for item in items:
            if item["id"] in self.items:
                raise ValueError(f"{self.module.SOURCE}: item {item['id']!r} discovered twice")
            self.items[item["id"]] = item
        if bound:
            self.bounds.append(bound)
        queued = {_key(r) for r in self.queue}
        for nxt in more:
            if _key(nxt) in self.made or _key(nxt) in queued:
                if getattr(self.module, "REPEATED_REQUESTS_OK", False):
                    continue
                raise ValueError(f"{self.module.SOURCE}: request asked for again (pagination loops): {nxt['url']}")
            self.queue.append(nxt)
            queued.add(_key(nxt))


def _item_key(module, item_id):
    return str(module.item_key(item_id)) if callable(getattr(module, "item_key", None)) else item_id


def _rows(module, capture, wanted):
    built = kit_rows.check_rows(module.listings(capture), module.SOURCE)
    keys = {r["native_id"] for r in built}
    if keys != wanted:
        missing, extra = sorted(wanted - keys)[:5], sorted(keys - wanted)[:5]
        raise ValueError(f"{module.SOURCE}: rows are not the discovered items (missing {missing}, extra {extra})")
    return built


def collect(module, *, fetch=None, max_pages=50, max_items=0, user_agent=None):
    """Run a catalog capture: discovery, then details. `max_items` > 0 stops after that many details (a pilot)."""
    fetch = fetch or Http(module.ORIGIN, module.INTERVAL, **({"user_agent": user_agent} if user_agent else {}))
    capture = {"format": FORMAT, "source": module.SOURCE, "origin": module.ORIGIN, "mode": "catalog",
               "started_at": utc(), "user_agent": getattr(fetch, "user_agent", None),
               "robots": getattr(fetch, "robots", None), "pages": [], "details": []}
    walk = _Walk(module)
    while not walk.done():
        if len(capture["pages"]) >= max_pages:
            walk.bounds.append(f"{max_pages} pages")
            break
        request = walk.take()
        response = fetch(request)
        capture["pages"].append(response)
        walk.add(response, request)
    if not walk.items:
        raise ValueError(f"{module.SOURCE}: discovery found no items")
    wanted = set()
    for item in walk.items.values():
        if item["request"] is None:
            wanted.add(_item_key(module, item["id"]))
            continue
        if max_items and len(capture["details"]) >= max_items:
            if f"{max_items} items" not in walk.bounds:
                walk.bounds.append(f"{max_items} items")
            continue
        response = fetch(item["request"])
        module.check_detail(response, item)
        capture["details"].append({**response, "item_id": item["id"]})
        wanted.add(_item_key(module, item["id"]))
    built = _rows(module, capture, wanted)
    capture["finished_at"] = utc()
    capture["status"] = {"items": len(walk.items), "details": len(capture["details"]), "rows": len(built),
                         "bounds": walk.bounds, "complete": not walk.bounds}
    return capture, built


def collect_page(module, url, *, fetch=None, user_agent=None):
    """Fetch one product page by URL and read it with the module's `page`."""
    if not callable(getattr(module, "page", None)):
        raise ValueError(f"{module.SOURCE}: has no page() reader")
    fetch = fetch or Http(module.ORIGIN, module.INTERVAL, **({"user_agent": user_agent} if user_agent else {}))
    # A source may read a product page through the site's own JSON for it (VTEX: /api/.../<slug>/p).
    request = module.page_request(url) if callable(getattr(module, "page_request", None)) else {"url": url}
    response = fetch(request)
    capture = {"format": FORMAT, "source": module.SOURCE, "origin": module.ORIGIN, "mode": "page",
               "started_at": response["observed_at"], "user_agent": getattr(fetch, "user_agent", None),
               "robots": getattr(fetch, "robots", None), "pages": [response], "details": []}
    built = kit_rows.check_rows(module.page(response), module.SOURCE)
    capture["finished_at"] = utc()
    capture["status"] = {"items": len(built), "details": 0, "rows": len(built), "bounds": [], "complete": True}
    return capture, built


def replay(capture, module):
    """The rows of a saved capture, re-derived offline. Raises ValueError when the module no longer reads it."""
    if capture.get("format") != FORMAT or capture.get("source") != module.SOURCE:
        raise ValueError("capture is not this source's kit capture")
    if capture["mode"] == "page":
        return kit_rows.check_rows(module.page(capture["pages"][0]), module.SOURCE)
    walk = _Walk(module)
    for n, response in enumerate(capture["pages"]):
        if walk.done():
            raise ValueError(f"saved page {n} was not asked for by discovery")
        request = walk.take()
        if response["url"] != request["url"] or response.get("request") != ({k: v for k, v in request.items()
                                                                              if k != "url"} or None):
            raise ValueError(f"saved page {n} is {response['url']}, discovery asks for {request['url']}")
        walk.add(response, request)
    bounded = bool(capture["status"]["bounds"])
    if not walk.done() and not bounded:
        raise ValueError("discovery asks for more pages than the capture saved, and the capture names no bound")
    details = {d["item_id"]: d for d in capture["details"]}
    if unknown := set(details) - set(walk.items):
        raise ValueError(f"saved details belong to no discovered item: {sorted(unknown)[:5]}")
    wanted = set()
    for item in walk.items.values():
        if item["request"] is None:
            wanted.add(_item_key(module, item["id"]))
        elif item["id"] in details:
            module.check_detail(details[item["id"]], item)
            wanted.add(_item_key(module, item["id"]))
        elif not bounded:
            raise ValueError(f"item {item['id']!r} has no saved detail, and the capture names no bound")
    return _rows(module, capture, wanted)


def save(capture, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(capture, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))
