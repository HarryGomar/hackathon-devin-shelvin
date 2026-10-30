"""Runs one source's own code and prints what it produced, as one JSON line. Only the gate starts it.

The gate (kit/gate.py) never imports the source it judges: it starts this in a child process, sends the saved
capture it read on stdin, and computes every check from what this prints. Nothing here decides anything, and
nothing the source does here (at import or at run time) reaches the gate's process.

    python -m kit.worker <SOURCE> [--live] [--product JSON]
"""
import argparse
import importlib
import json
import re
import sys
import urllib.error

from . import capture as kit_capture
from .http import Refused
from .source import check_source


def produce(module, saved, *, live=False, product=None, fetch=None):
    """The rows of `saved` replayed and, with `live`, of a fresh paced collection. Errors are reported, not raised."""
    out = {"offline": None, "live": None}
    if saved is not None:
        try:
            out["offline"] = {"rows": kit_capture.replay(saved, module)}
        except Exception as exc:   # any error in the source's code is that build's failure
            out["offline"] = {"error": f"{type(exc).__name__}: {exc}"[:300]}
    if live:
        out["live"] = _live(module, product, fetch)
    return out


def _live(module, product, fetch):
    catalog = callable(getattr(module, "listings", None))
    page_url = (product or {}).get("url") or getattr(module, "SAMPLE_PAGE", None)
    try:
        if callable(getattr(module, "page", None)) and page_url and (module.KIND == "third_party" or not catalog):
            saved, found = kit_capture.collect_page(module, page_url, fetch=fetch)
        else:
            saved, found = kit_capture.collect(module, max_pages=3, max_items=10, fetch=fetch)
    except (Refused, urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        return {"unreachable": str(exc)[:300]}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"[:300]}

    def asked(responses):
        return [{"url": r["url"], "request": r.get("request")} for r in responses]

    # The requests (not the bodies) go back, so the gate can fetch one of them again itself.
    return {"rows": found, "bounds": saved["status"]["bounds"], "pages": asked(saved["pages"]),
            "details": asked(saved["details"])}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kit.worker")
    parser.add_argument("source")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--product")
    args = parser.parse_args(argv)
    saved = json.loads(sys.stdin.read() or "null")
    try:
        if not re.fullmatch(r"[a-z][a-z0-9_]*", args.source):
            raise ValueError("SOURCE must match [a-z][a-z0-9_]*")
        module = check_source(importlib.import_module(f"sources.{args.source}"))
        if module.SOURCE != args.source:
            raise ValueError(f"sources/{args.source}.py: SOURCE must equal the file name")
        product = json.loads(args.product) if args.product else None
        result = {"loads": True, **produce(module, saved, live=args.live, product=product)}
    except Exception as exc:
        result = {"loads": f"{type(exc).__name__}: {exc}"[:300]}
    # The gate reads the last line; anything the source printed comes before it.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write("\n" + json.dumps(result, ensure_ascii=False, default=str) + "\n")


if __name__ == "__main__":
    main()
