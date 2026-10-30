"""`SEARCH=devin`: page search as a Devin session, the same prompt and answer schema as `SEARCH=claude`.

UNTESTED against the live API (no DEVIN_API_KEY was available when this was written). It follows the v3 fields the
builder uses (runners.DevinRunner): POST /sessions with `structured_output_schema`, then GET /sessions/{id} until
`structured_output` holds the answer. The answer goes through web_search.parse_answer, so a page from Devin is
checked like one from Claude (domain policy, first/third party, duplicates, ranking). Devin has no list of the
URLs its searches returned, so no page is downgraded for "not seen in search results".
"""
import time

from .runners import devin_call
from .web_search import SEARCH_SCHEMA, SEARCH_SYSTEM, SearchError, build_prompt, parse_answer


class DevinSearch:
    def __init__(self, config, call=None, sleep=time.sleep):
        self.config, self.call, self.sleep = config, call or (lambda *a: devin_call(config, *a)), sleep

    def __call__(self, product, request=None):
        request = {"scanType": "both", "includeSimilar": False, **(request or {}), "product": product}
        started = time.time()
        prompt = (f"{SEARCH_SYSTEM}\n\nUse your browser or web search; do not write code or open a pull request. "
                  f"Report the answer as your structured output.\n\n{build_prompt(request)}")
        try:
            created = self.call("POST", "/sessions", {
                "prompt": prompt, "structured_output_schema": SEARCH_SCHEMA, "structured_output_required": True,
                "max_acu_limit": self.config.devin_search_max_acu, "tags": ["page-search"],
                "title": f"Find pages: {product.get('brand', '')} {product.get('productName', '')}".strip()})
        except RuntimeError as exc:
            raise SearchError(f"Devin search could not start: {exc}", "not_configured") from None
        session_id, got = created["session_id"], {}
        while time.time() - started < self.config.search_timeout:
            self.sleep(self.config.devin_poll_seconds)
            got = self.call("GET", f"/sessions/{session_id}")
            answer = got.get("structured_output")
            if isinstance(answer, dict) and isinstance(answer.get("pages"), list) and (
                    got.get("status_detail") in ("finished", "waiting_for_user") or got.get("status") in ("exit", "suspended")):
                found = parse_answer(answer, request)
                found["recordedBy"] = "Devin search session"
                found["run"] = {"provider": "devin", "sessionId": session_id, "sessionUrl": got.get("url"),
                                "acus": got.get("acus_consumed"), "seconds": round(time.time() - started, 1)}
                return found
            if got.get("status") in ("exit", "error", "suspended"):
                break
        raise SearchError(f"Devin search ended without an answer ({got.get('status') or 'timed out'})", "incomplete")
