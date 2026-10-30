"""`uv run python -m kit <command>`: the kit's commands. Every command prints JSON.

    list                          every source: SOURCE, host, KIND, RETAILER
    find <url or host>            the sources that collect that host (check before building one)
    probe <url> [--write ...]     which generic reader fits the site; --write saves sources/<SOURCE>.py
    collect <SOURCE> [--out F]    catalog capture (network), its rows, saved to captures/ unless --out
    page <url> [--out F]          one product page by URL, through its source or the generic page reader
    replay <capture.json>         rows of a saved capture, offline
    fixture <SOURCE> <capture>    copy a capture to fixtures/<SOURCE>/capture.json and write expected.json
    gate <SOURCE> [--live]        the pass/fail decision (exit 0 pass, 1 fail, 2 unreachable)
    access <url>                  may we fetch this page: robots.txt and the AI-agent opt-out rule
    progress <stage> <message>    a builder's progress line, appended to progress.jsonl for the backend
"""
import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from . import capture as kit_capture
from . import gate as kit_gate
from . import probe as kit_probe
from . import source as kit_source
from .generic import page as generic_page
from .http import Http

ROOT = kit_source.ROOT


def _print(value):
    # Windows consoles default to a legacy code page; site text is UTF-8.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=1, default=str) + "\n")


def _out(path, capture):
    if path is None:
        stamp = capture["started_at"].replace(":", "").replace("-", "")
        path = ROOT / "captures" / capture["source"] / f"{stamp}-{capture['mode']}.json"
    return str(kit_capture.save(capture, path))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kit", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    find = sub.add_parser("find")
    find.add_argument("target")
    probe = sub.add_parser("probe")
    probe.add_argument("url")
    probe.add_argument("--write", metavar="SOURCE", help="save sources/<SOURCE>.py for a generic fit")
    probe.add_argument("--retailer")
    probe.add_argument("--kind", choices=kit_source.KINDS, default="third_party")
    probe.add_argument("--brand", action="append", default=[])
    probe.add_argument("--currency", default="MXN")
    probe.add_argument("--product-path", help="regex of product page paths, for a sitemap reader")
    collect = sub.add_parser("collect")
    collect.add_argument("source")
    collect.add_argument("--out")
    collect.add_argument("--max-pages", type=int, default=50)
    collect.add_argument("--max-items", type=int, default=0, help="0: every item; N: a pilot of N details")
    page = sub.add_parser("page")
    page.add_argument("url")
    page.add_argument("--out")
    replay = sub.add_parser("replay")
    replay.add_argument("capture")
    fixture = sub.add_parser("fixture")
    fixture.add_argument("source")
    fixture.add_argument("capture")
    gate = sub.add_parser("gate")
    gate.add_argument("source")
    gate.add_argument("--live", action="store_true", help="also collect live (network), paced and capped")
    gate.add_argument("--product", help="JSON of the scanned product (brand, productName, size, barcode, url)")
    gate.add_argument("--min-rows", type=int, default=kit_gate.MIN_BRAND_ROWS)
    access = sub.add_parser("access")
    access.add_argument("url")
    progress = sub.add_parser("progress")
    progress.add_argument("stage", choices=["searching", "probing", "writing", "capturing", "testing", "gate", "fixing",
                                            "reporting"])
    progress.add_argument("message")
    args = parser.parse_args(argv)

    if args.command == "progress":
        line = {"at": kit_capture.utc(), "stage": args.stage, "message": args.message}
        with open(os.environ.get("KIT_PROGRESS_FILE", "progress.jsonl"), "a", encoding="utf-8") as out:
            out.write(json.dumps(line, ensure_ascii=False) + "\n")
        _print(line)
        return
    if args.command == "access":
        part = urlsplit(args.url)
        _print({"url": args.url, **Http(f"{part.scheme}://{part.netloc}", 1).access(args.url)})
        return
    if args.command == "gate":
        # Before any source is loaded: the gate runs the source it judges in a child process, never in this one.
        report = kit_gate.check(args.source, live=args.live, product=json.loads(args.product) if args.product else None,
                                min_rows=args.min_rows)
        _print(report)
        sys.stderr.write(kit_gate.summary(report) + "\n")
        sys.exit({"pass": 0, "fail": 1, "unreachable": 2}[report["verdict"]])

    sources = kit_source.load()
    if args.command == "list":
        _print([{"source": m.SOURCE, "host": kit_source.host(m), "kind": m.KIND, "retailer": m.RETAILER}
                for m in sources.values()])
    elif args.command == "find":
        target = args.target if "//" in args.target else f"https://{args.target}/"
        _print([m.SOURCE for m in kit_source.for_url(sources, target)])
    elif args.command == "probe":
        report = kit_probe.probe(args.url)
        if args.write:
            text = kit_probe.source_text(report, args.write, args.retailer or report["host"], args.kind,
                                         tuple(args.brand), args.currency, args.product_path)
            path = ROOT / "sources" / f"{args.write}.py"
            if path.exists():
                raise SystemExit(f"{path} exists; extend it instead")
            path.write_text(text, encoding="utf-8")
            report["written"] = str(path)
        _print(report)
    elif args.command == "collect":
        module = sources.get(args.source) or sys.exit(f"unknown source {args.source}; see `kit list`")
        capture, rows = kit_capture.collect(module, max_pages=args.max_pages, max_items=args.max_items)
        _print({"saved": _out(args.out, capture), "status": capture["status"], "first_rows": rows[:3]})
    elif args.command == "page":
        found = kit_source.for_url(sources, args.url)
        if found:
            capture, rows = kit_capture.collect_page(found[0], args.url)
        else:
            part = urlsplit(args.url)
            fetch = Http(f"{part.scheme}://{part.netloc}", 2)
            response = fetch({"url": args.url})
            rows = generic_page.read(response)
            capture = {"format": kit_capture.FORMAT, "source": "_generic", "origin": fetch.origin, "mode": "page",
                       "started_at": response["observed_at"], "robots": fetch.robots, "pages": [response],
                       "details": [], "status": {"rows": len(rows), "bounds": [], "complete": True}}
        _print({"saved": _out(args.out, capture), "rows": rows})
    elif args.command == "replay":
        capture = kit_capture.read(args.capture)
        module = sources.get(capture["source"]) or sys.exit(f"unknown source {capture['source']}")
        rows = kit_capture.replay(capture, module)
        _print({"rows": len(rows), "first_rows": rows[:3]})
    elif args.command == "fixture":
        module = sources.get(args.source) or sys.exit(f"unknown source {args.source}")
        capture = kit_capture.read(args.capture)
        rows = kit_capture.replay(capture, module)
        folder = ROOT / "fixtures" / module.SOURCE
        kit_capture.save(capture, folder / "capture.json")
        expected = folder / "expected.json"
        if not expected.exists():
            # A draft only: the builder replaces `spot` with values read from the saved bodies by eye, so the
            # test checks the parser against the page, not against itself.
            draft = {"rows": len(rows), "spot": [{"native_id": r["native_id"], "title": r["title"],
                                                  "price": r["price"]} for r in rows[:2]],
                     "written_by": "DRAFT: replace spot values with ones read from the page"}
            expected.write_text(json.dumps(draft, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        _print({"fixture": str(folder), "rows": len(rows)})


if __name__ == "__main__":
    main()
