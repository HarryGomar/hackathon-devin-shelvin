"""One line per request and per finished job (spec 10).

Route, status, duration, jobId and, for Claude runs, model, tokens, searches and estimated cost. Never the
Authorization header, the token, an API key or client addresses: callers pass only the fields below.
"""
import json
import sys
import time


def log(event, **fields):
    parts = [time.strftime("%H:%M:%S"), event]
    for key, value in fields.items():
        if value is None or value == {}:
            continue
        if isinstance(value, dict):
            value = json.dumps({k: v for k, v in value.items() if v is not None}, ensure_ascii=False, separators=(",", ":"))
        parts.append(f"{key}={value}")
    print(" ".join(str(p) for p in parts), file=sys.stdout, flush=True)
