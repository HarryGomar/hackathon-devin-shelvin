"""The one pass/fail decision for a source. Code decides; nothing a builder says about its own work counts.

The same gate runs in three places: the builder runs it before it reports, the backend runs it on the builder's
result before it merges, and CI runs it on the PR. Two levels:

- offline (`check`): the source declares its origin and kind, its fixture exists, expected.json was written from the
  page (not the draft), the capture replays, the rows equal what expected.json states, their titles are in the saved
  page, and the rows are plausible;
- live (`check(..., live=True)`, `kit gate --live`): a fresh, paced, robots-checked collection with small caps, held
  to the same plausibility rules, a minimum row count for a brand catalog, the scanned product when one is given, and
  one page the source read, fetched again by the gate itself, which must carry a row's title.

The gate never imports the source it judges. It reads the source's constants from the file's text, runs the
source's code in a child process (kit/worker.py) that only prints rows, and computes every check here, so nothing
the source does at import or run time can change a check. The rows are not taken on trust either: their titles
must be in the saved page and, live, in a page the gate fetched. The child is a separate process, not a sandbox: it
runs with the permissions of whoever runs the gate.

The verdict is `pass`, `fail` (the code is wrong: send the report back to the builder) or `unreachable` (the site
or network failed: retry later, never send it to the builder, because there is nothing in the code to fix).
"""
import hashlib
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

from . import capture as kit_capture
from . import match as kit_match
from . import robots, worker
from .http import Http
from .rows import check_rows
from .source import KINDS, ROOT, check_source, declared

HOME = Path(__file__).resolve().parents[1]   # this kit, importable by the child wherever ROOT is
MAX_FIXTURE_BYTES = 3_000_000
MIN_BRAND_ROWS = 5
CHILD_SECONDS = 540
ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")


class _Checks:
    def __init__(self):
        self.items = []

    def add(self, name, passed, detail=""):
        self.items.append({"name": name, "passed": bool(passed), "detail": detail})
        return passed

    @property
    def passed(self):
        return all(c["passed"] for c in self.items)


def _host(constants):
    return (urlsplit(str((constants or {}).get("ORIGIN") or "")).hostname or "").removeprefix("www.")


def _declarations(sources):
    """Each source's constants: read from the files without running them, or from `sources` (tests)."""
    if sources is not None:
        return {n: {k: getattr(m, k, None) for k in ("SOURCE", "ORIGIN", "KIND")} for n, m in sources.items()}
    found = {}
    for path in sorted((ROOT / "sources").glob("*.py")):
        if not path.stem.startswith("_"):
            try:
                found[path.stem] = declared(path)
            except (SyntaxError, ValueError) as exc:
                found[path.stem] = {"error": f"{type(exc).__name__}: {exc}"[:300]}
    return found


def _declares(name, constants, checks):
    constants = constants or {}
    origin = urlsplit(constants["ORIGIN"] if isinstance(constants.get("ORIGIN"), str) else "")
    good = (constants.get("SOURCE") == name and constants.get("KIND") in KINDS and bool(origin.hostname)
            and (origin.scheme == "https" or (origin.scheme, origin.hostname) == ("http", "127.0.0.1")))
    detail = (f"sources/{name}.py" if good else constants.get("error")
              or (f"sources/{name}.py must set SOURCE = {name!r}, ORIGIN = 'https://...' and KIND as literals"
                  if constants else f"no source {name}"))
    return checks.add("source_declares", good, detail)


def _digest(name):
    """sha256 of the source file and its fixture folder, to show the source's run changed neither."""
    sha = hashlib.sha256()
    for path in [ROOT / "sources" / f"{name}.py", *sorted((ROOT / "fixtures" / name).rglob("*"))]:
        if path.is_file():
            sha.update(path.relative_to(ROOT).as_posix().encode() + b"\0" + path.read_bytes())
    return sha.hexdigest()


def _run(name, saved, live, product, sources, fetch):
    """What the source's own code produced (kit/worker.py): in a child process, or here for `sources` (tests)."""
    if sources is not None:
        try:
            module = check_source(sources[name])
        except Exception as exc:
            return {"loads": f"{type(exc).__name__}: {exc}"[:300]}
        return {"loads": True, **worker.produce(module, saved, live=live, product=product, fetch=fetch)}
    command = [sys.executable, "-m", "kit.worker", name] + (["--live"] if live else [])
    if product:
        command += ["--product", json.dumps(product, ensure_ascii=False)]
    path = os.pathsep.join(p for p in (str(HOME), os.environ.get("PYTHONPATH")) if p)
    try:
        done = subprocess.run(command, cwd=ROOT, input=json.dumps(saved, ensure_ascii=False), capture_output=True,
                              encoding="utf-8", errors="replace", timeout=CHILD_SECONDS,
                              env={**os.environ, "PYTHONPATH": path, "PYTHONIOENCODING": "utf-8"})
    except subprocess.TimeoutExpired:
        return {"loads": f"the source's code ran over {CHILD_SECONDS} s"}
    try:
        result = json.loads(done.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        result = None
    if not isinstance(result, dict):
        return {"loads": f"kit.worker printed no result (exit {done.returncode}): {done.stderr.strip()[-300:]}"}
    return result


def _rows(result, checks, name, detail):
    """The rows the source's code produced, checked for shape here; None (and a failed check) when there are none."""
    try:
        if "error" in result:
            raise ValueError(result["error"])
        found = check_rows(result["rows"])
    except (KeyError, TypeError, ValueError) as exc:
        checks.add(name, False, str(exc)[:300])
        return None
    checks.add(name, True, detail.format(n=len(found)))
    return found


def _page_words(responses):
    """The words of response bodies, with JSON \\u escapes and HTML entities decoded."""
    text = " ".join(str(r.get("body") or "") for r in responses)
    return kit_match.words(html.unescape(ESCAPE.sub(lambda m: chr(int(m[1], 16)), text)))


def _on_page(row, words):
    return bool(row["title"]) and kit_match.words(row["title"]) <= words


def plausible(constants, found, checks, where):
    """Rows look like products of this site: titles, URLs on the origin, and prices for a retailer."""
    if not checks.add(f"{where}_rows", len(found) > 0, f"{len(found)} rows"):
        return
    titled = sum(1 for r in found if r["title"] and r["title"].strip())
    checks.add(f"{where}_titles", titled >= 0.9 * len(found), f"{titled}/{len(found)} rows have a title")
    base = _host(constants)
    on_site = sum(1 for r in found if (urlsplit(r["url"]).hostname or "").removeprefix("www.") == base)
    checks.add(f"{where}_urls_on_site", on_site == len(found), f"{on_site}/{len(found)} row URLs are on {base}")
    if constants["KIND"] == "third_party":
        priced = sum(1 for r in found if r["price"] and r["price"]["amount"] > 0)
        checks.add(f"{where}_prices", priced >= 0.8 * len(found), f"{priced}/{len(found)} rows have a positive price")


def _fixture(name, checks):
    """The saved capture and expected.json, read here before the source's code runs."""
    folder = ROOT / "fixtures" / name
    path, expected_path = folder / "capture.json", folder / "expected.json"
    if not checks.add("fixture_exists", path.is_file() and expected_path.is_file(),
                      f"fixtures/{name}/capture.json and expected.json"):
        return None, None
    size = path.stat().st_size
    checks.add("fixture_size", size <= MAX_FIXTURE_BYTES, f"{size:,} bytes (limit {MAX_FIXTURE_BYTES:,})")
    try:
        saved, expected = kit_capture.read(path), json.loads(expected_path.read_text(encoding="utf-8"))
        page_urls = [p["url"] for p in saved["pages"]] + [d["url"] for d in saved["details"]]
    except (ValueError, KeyError, TypeError) as exc:
        checks.add("fixture_reads", False, f"{type(exc).__name__}: {exc}"[:300])
        return None, None
    written = not str(expected.get("written_by", "")).startswith("DRAFT") and bool(expected.get("spot"))
    checks.add("expected_written", written, "spot values read from the saved page, not the draft")
    if saved.get("robots"):
        refused = [u for u in page_urls
                   if robots.access(saved["robots"]["status"], saved["robots"]["body"], u, saved.get("user_agent") or "")[
                       "status"] != "allowed"]
        checks.add("fixture_robots", not refused, f"{len(refused)} saved URLs refused by robots" if refused
                   else "every saved URL was allowed by robots.txt")
    return saved, expected


def _offline(constants, saved, expected, result, checks):
    found = _rows(result or {}, checks, "replay", "{n} rows from the saved capture")
    if found is None:
        return []
    by_id = {r["native_id"]: r for r in found}
    checks.add("expected_rows", len(found) == expected.get("rows"), f"{len(found)} rows, expected.json says {expected.get('rows')}")
    wrong = []
    for spot in expected.get("spot") or []:
        row = by_id.get(spot.get("native_id"))
        if row is None:
            wrong.append(f"no row {spot.get('native_id')}")
            continue
        wrong += [f"{spot['native_id']}.{k}: {row.get(k)!r} != {v!r}" for k, v in spot.items() if row.get(k) != v]
    checks.add("expected_values", not wrong, "; ".join(wrong[:5]) or "every spot value matches")
    words = _page_words(saved["pages"] + saved["details"])
    titled = [r for r in found if r["title"]]
    grounded = sum(1 for r in titled if _on_page(r, words))
    checks.add("fixture_grounded", grounded >= 0.9 * len(titled),
               f"{grounded}/{len(titled)} row titles are in the saved page")
    plausible(constants, found, checks, "fixture")
    return found


def _refetch(constants, result, found, checks, fetch):
    """Fetch one page the source read, here, and find a row's title in it: the rows came from the site."""
    asked = [r for r in (result.get("details") or result.get("pages") or []) if isinstance(r, dict)]
    if not checks.add("live_page_named", bool(asked), "the source names the pages it read"):
        return None
    request = {"url": str(asked[0].get("url")),
               **{k: v for k, v in (asked[0].get("request") or {}).items() if k in ("json", "form")}}
    part, base = urlsplit(request["url"]), urlsplit(constants["ORIGIN"])
    if not checks.add("live_page_on_site", (part.scheme, part.netloc) == (base.scheme, base.netloc),
                      f"{request['url']} on {constants['ORIGIN']}"):
        return None
    try:
        response = (fetch or Http(constants["ORIGIN"], 2))(request)
    except (ValueError, OSError) as exc:   # Refused and decode errors are ValueErrors; network errors are OSErrors
        checks.add("live_reachable", False, f"the gate's own request: {exc}"[:300])
        return "unreachable"
    words = _page_words([response])
    grounded = sum(1 for r in found if _on_page(r, words))
    checks.add("live_grounded", grounded > 0, f"{grounded}/{len(found)} row titles are in {request['url']}, fetched by the gate")
    return None


def _live(constants, result, checks, product, min_rows, fetch):
    if "unreachable" in result:
        checks.add("live_reachable", False, str(result["unreachable"])[:300])
        return None, "unreachable"
    found = _rows(result, checks, "live_collect", "{n} rows, bounds " + (", ".join(map(str, result.get("bounds") or [])) or "none"))
    if found is None:
        return [], None
    plausible(constants, found, checks, "live")
    if constants["KIND"] == "first_party":   # a first_party source is a catalog (kit/source.py)
        checks.add("live_catalog_size", len(found) >= min_rows,
                   f"{len(found)} rows; a brand catalog source must reach {min_rows} (cover the whole site)")
    if product and (product.get("productName") or product.get("barcode")):
        best = kit_match.matches(product, found, threshold=0.6)
        checks.add("live_product_found", bool(best),
                   f"best match {best[0][1]['title']!r} ({best[0][0]})" if best else "the scanned product is not among the rows")
    return found, _refetch(constants, result, found, checks, fetch)


def check(name, *, live=False, product=None, min_rows=MIN_BRAND_ROWS, sources=None, fetch=None):
    """The gate report for source `name`. With `sources` (tests) their code runs here instead of in a child, and
    `fetch` answers the gate's own live request."""
    checks = _Checks()
    found = _declarations(sources)
    constants = found.get(name)
    if not _declares(name, constants, checks):
        return {"source": name, "verdict": "fail", "checks": checks.items, "rows": 0}
    others = [n for n, c in found.items() if n != name and _host(c) == _host(constants)]
    checks.add("one_source_per_host", not others, f"also collected by {others}" if others else _host(constants))
    saved, expected = _fixture(name, checks)
    before = _digest(name)
    result = _run(name, saved, live, product, sources, fetch)
    checks.add("files_unchanged", _digest(name) == before, "the source's run left its file and fixture as the gate read them")
    if not checks.add("source_loads", result.get("loads") is True,
                      f"sources/{name}.py" if result.get("loads") is True else str(result.get("loads"))[:300]):
        return {"source": name, "verdict": "fail", "checks": checks.items, "rows": 0}
    rows = _offline(constants, saved, expected, result.get("offline"), checks) if saved is not None else []
    verdict = None
    if live:
        live_rows, verdict = _live(constants, result.get("live") or {}, checks, product, min_rows, fetch)
        rows = live_rows if live_rows is not None else rows
    verdict = verdict or ("pass" if checks.passed else "fail")
    if verdict == "unreachable" and not all(c["passed"] for c in checks.items if c["name"] != "live_reachable"):
        verdict = "fail"   # the other checks already failed: that is code to fix
    return {"source": name, "verdict": verdict, "checks": checks.items, "rows": len(rows)}


def summary(report):
    """One line per failed check, for the builder."""
    failed = [c for c in report["checks"] if not c["passed"]]
    head = f"kit gate {report['source']}: {report['verdict']} ({len(report['checks']) - len(failed)}/{len(report['checks'])} checks passed)"
    return "\n".join([head] + [f"- {c['name']}: {c['detail']}" for c in failed])
