"""Listings-search benchmark: runs the backend's Claude page search on products with a hand-checked answer key.

    set -a; . backend/.env; set +a                     # the key stays in the environment, never printed
    python3 tools/search-benchmark/bench.py run base --products all [--similar] [--parallel 4]
    python3 tools/search-benchmark/bench.py score base base-similar new
    python3 tools/search-benchmark/bench.py unjudged base   # pages the key does not know yet, to label in products.json

`run` calls backend/server/web_search.py in-process (no server, no database) and saves each answer with its run record
under results/<label>/ (git-ignored), so scoring again is free. A label that already has a product's answer skips it.
Metrics per label: precision (exact pages the key marks correct / exact pages judged), recall (correct pages found /
correct pages in the key, matched by retailer item id), first-party hit rate, wrong pages marked verified, dead URLs
(GET: 404/410, or redirected to a home/search page), p50/p90 latency, US$ per search, web searches per search.
"""
import argparse
import concurrent.futures
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# BENCH_BACKEND=<dir with server/> benchmarks another copy of the backend (e.g. the baseline from `git archive`).
sys.path.insert(0, os.environ.get("BENCH_BACKEND") or str(HERE.parents[1] / "backend"))
from server.config import Config  # noqa: E402
from server.web_search import ClaudeSearch, SearchError, domain_of, normalize_url  # noqa: E402

KEY = HERE / "products.json"
RESULTS = HERE / "results"
LIVE_CACHE = RESULTS / "_live.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")


def item_key(url):
    """A retailer's stable item id when the URL has one (ASIN, MLM id, long number), else the normalized URL."""
    n = normalize_url(url)
    host = n.split("/")[0]
    root = ".".join(host.split(".")[-3:]) if host.endswith(".mx") else ".".join(host.split(".")[-2:])
    path = n[len(host):]
    if root == "ikea.com":   # one item number in every country: the country is part of the key
        root += "/" + path.strip("/").split("/")[0]
    if m := re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", path, re.I):
        return f"{root}:{m.group(1).upper()}"
    if m := re.search(r"MLM-?(\d{6,})", path, re.I):
        return f"mercadolibre:MLM{m.group(1)}"
    digits = re.findall(r"\d{6,}", path)
    if digits:
        return f"{root}:{digits[-1].lstrip('0')}"
    return n


def load_key():
    return {p["id"]: p for p in json.loads(KEY.read_text(encoding="utf-8"))["products"]}


def request_product(p):
    return {k: p[k] for k in ("id", "brand", "productName", "variant", "size", "barcode", "manufacturer") if p.get(k)}


# --- run --------------------------------------------------------------------------------------------------------
def run_one(search, p, similar, out):
    path = out / f"{p['id']}.json"
    if path.exists():
        return json.loads(path.read_text())
    started = time.time()
    try:
        found = search(request_product(p), {"scanType": "both", "includeSimilar": similar})
        record = {"pages": found["pages"], "similarProducts": found.get("similarProducts", []),
                  "run": found.get("run"), "error": None}
    except SearchError as exc:
        record = {"pages": [], "similarProducts": [], "run": getattr(exc, "run", None), "error": f"{exc.code}: {exc}"}
    record["wall"] = round(time.time() - started, 1)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1))
    usd = (record["run"] or {}).get("usd")
    print(f"  {p['id']}: {len(record['pages'])} pages, {record['wall']} s, ${usd}, {record['error'] or 'ok'}", flush=True)
    return record


def cmd_run(args):
    key = load_key()
    ids = list(key) if args.products == "all" else args.products.split(",")
    out = RESULTS / args.label
    out.mkdir(parents=True, exist_ok=True)
    import server.web_search as ws
    overrides = {}
    for item in args.set or []:
        name, _, value = item.partition("=")
        try:
            overrides[name] = json.loads(value)
        except json.JSONDecodeError:
            overrides[name] = value
        if not hasattr(ws, name):
            raise SystemExit(f"web_search has no {name}")
        setattr(ws, name, overrides[name])
    (out / "_meta.json").write_text(json.dumps({"similar": args.similar, "set": overrides,
                                                "backend": os.environ.get("BENCH_BACKEND"), "at": time.strftime("%F %T")}))
    search = ClaudeSearch(Config())
    with concurrent.futures.ThreadPoolExecutor(args.parallel) as pool:
        list(pool.map(lambda i: run_one(search, key[i], args.similar, out), ids))
    print(f"spent so far: ${total_spend():.2f}")


def total_spend():
    return sum(((json.loads(f.read_text()).get("run") or {}).get("usd") or 0)
               for f in RESULTS.glob("*/*.json") if not f.name.startswith("_"))


# --- liveness --------------------------------------------------------------------------------------------------
def check_live(url):
    """'live' | 'dead' | 'blocked' (bot wall, unknown) | 'error' and the page <title> when readable."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            final = r.geturl()
            body = r.read(400_000).decode("utf-8", "replace")
            title = (re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I) or [None, ""])[1].strip()[:160]
            moved = normalize_url(final) != normalize_url(url)
            path = re.sub(r"^https?://[^/]+", "", final)
            if moved and (path.strip("/") == "" or re.search(r"search|busca|/s\?|q=", path, re.I)):
                return {"status": "dead", "code": r.status, "final": final, "title": title}
            return {"status": "live", "code": r.status, "final": final if moved else None, "title": title}
    except urllib.error.HTTPError as exc:
        return {"status": "dead" if exc.code in (404, 410) else "blocked", "code": exc.code}
    except Exception as exc:  # noqa: BLE001 - DNS, TLS, timeouts: recorded, not dead
        return {"status": "error", "code": None, "error": type(exc).__name__}


def live_map(urls):
    cache = json.loads(LIVE_CACHE.read_text()) if LIVE_CACHE.exists() else {}
    todo = [u for u in set(urls) if u not in cache]
    with concurrent.futures.ThreadPoolExecutor(12) as pool:
        for u, res in zip(todo, pool.map(check_live, todo)):
            cache[u] = res
    LIVE_CACHE.parent.mkdir(exist_ok=True)
    LIVE_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
    return cache


# --- score -----------------------------------------------------------------------------------------------------
def judge(p, url):
    """"correct" | "wrong" | "uncertain" (the key itself is unsure; counted neither way) | None (not in the key)."""
    lists = (("correct", p.get("correct", [])), ("wrong", p.get("wrong", [])), ("uncertain", p.get("uncertain", [])))
    n = normalize_url(url)
    for verdict, items in lists:
        if any(normalize_url(x["url"]) == n for x in items):
            return verdict
    k = item_key(url)
    for verdict, items in lists:
        if any(item_key(x["url"]) == k for x in items):
            return verdict
    return None


def first_party_url(p, url):
    n = normalize_url(url)
    return any(n.startswith(d) or n.split("/")[0].endswith("." + d.split("/")[0]) and "/" not in d
               for d in p.get("firstPartyDomains", []))


def records(label):
    out = RESULTS / label
    return {f.stem: json.loads(f.read_text()) for f in sorted(out.glob("*.json")) if not f.name.startswith("_")}


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "-"


def score(label, key, live):
    recs = records(label)
    c = {"found": 0, "correct": 0, "wrong": 0, "unjudged": 0, "key": 0, "hit": 0, "fp": 0, "fp_possible": 0,
         "wrong_verified": 0, "keyUncertain": 0, "dead": 0, "checked": 0, "errors": 0, "verified": 0, "verified_correct": 0}
    secs, usd, searches = [], [], []
    for pid, rec in recs.items():
        p = key.get(pid)
        if not p:
            continue
        run = rec.get("run") or {}
        if run:
            secs.append(run.get("seconds") or rec.get("wall"))
            usd.append(run.get("usd") or 0)
            searches.append((run.get("usage") or {}).get("searches") or 0)
        if rec.get("error"):
            c["errors"] += 1
        exact = [x for x in rec["pages"] if x.get("matchType", "exact") == "exact"
                 and x["verification"]["status"] != "rejected"]
        found_keys = set()
        for x in exact:
            v = judge(p, x["url"])
            c["found"] += 1
            c[v if v in ("correct", "wrong") else "unjudged" if v is None else "keyUncertain"] += 1
            found_keys.add(item_key(x["url"]))
            if x["verification"]["status"] == "verified":
                c["verified"] += 1
                c["verified_correct"] += v == "correct"
                c["wrong_verified"] += v == "wrong"
            st = live.get(x["url"], {}).get("status")
            if st in ("live", "dead"):
                c["checked"] += 1
                c["dead"] += st == "dead"
        keyset = {item_key(k["url"]) for k in p.get("correct", [])}
        c["key"] += len(keyset)
        c["hit"] += len(keyset & found_keys)
        if any(first_party_url(p, k["url"]) for k in p.get("correct", [])):
            c["fp_possible"] += 1
            c["fp"] += any(first_party_url(p, x["url"]) and judge(p, x["url"]) == "correct" for x in exact)
    q = lambda xs, f: (statistics.quantiles(xs, n=10)[int(f * 10) - 1] if len(xs) >= 2 else (xs[0] if xs else 0))
    judged = c["correct"] + c["wrong"]
    return {"label": label, "n": len(recs), "errors": c["errors"],
            "precision": pct(c["correct"], judged), "unjudged": c["unjudged"],
            "recall": pct(c["hit"], c["key"]), "firstParty": f"{c['fp']}/{c['fp_possible']}",
            "pagesPerSearch": round(c["found"] / max(1, len(recs)), 1),
            "verifiedPrecision": pct(c["verified_correct"], c["verified"]),
            "wrongVerified": c["wrong_verified"], "dead": f"{c['dead']}/{c['checked']}",
            "p50s": round(statistics.median(secs), 1) if secs else "-", "p90s": round(q(secs, 0.9), 1) if secs else "-",
            "usd": round(statistics.mean(usd), 3) if usd else "-", "searches": round(statistics.mean(searches), 1) if searches else "-"}


def cmd_score(args):
    key = load_key()
    urls = [x["url"] for lab in args.labels for r in records(lab).values() for x in r["pages"]]
    live = live_map(urls) if not args.no_live else {}
    rows = [score(lab, key, live) for lab in args.labels]
    cols = list(rows[0])
    print(" | ".join(cols))
    for r in rows:
        print(" | ".join(str(r[c]) for c in cols))
    print(f"total spend across results/: ${total_spend():.2f}")


def cmd_unjudged(args):
    key = load_key()
    live = json.loads(LIVE_CACHE.read_text()) if LIVE_CACHE.exists() else {}
    for lab in args.labels:
        for pid, rec in records(lab).items():
            for x in rec["pages"]:
                if x.get("matchType", "exact") == "exact" and pid in key and judge(key[pid], x["url"]) is None:
                    lv = live.get(x["url"], {})
                    print(f"{pid}\t{x['verification']['status']}\t{x['url']}\t{x['title'][:80]}\t{lv.get('status')}:{lv.get('title', '')[:60]}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("label")
    r.add_argument("--products", default="all")
    r.add_argument("--similar", action="store_true")
    r.add_argument("--parallel", type=int, default=4)
    r.add_argument("--set", action="append", help="NAME=VALUE: override a web_search module constant (JSON value)")
    s = sub.add_parser("score")
    s.add_argument("labels", nargs="+")
    s.add_argument("--no-live", action="store_true")
    u = sub.add_parser("unjudged")
    u.add_argument("labels", nargs="+")
    args = ap.parse_args()
    {"run": cmd_run, "score": cmd_score, "unjudged": cmd_unjudged}[args.cmd](args)


if __name__ == "__main__":
    main()
