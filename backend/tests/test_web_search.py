"""SEARCH=claude: the app's page search ported to the backend, offline (a fake Messages API)."""
import json

import pytest

from server import web_search
from server.config import Config
from server.web_search import ClaudeSearch, SearchError, brand_domain_guesses, domain_policy, parse_response
from tests.conftest import make_service, wait

IKEA = {"id": "choklad-not-100-g", "brand": "IKEA", "productName": "CHOKLAD NÖT", "size": "100 g",
        "manufacturer": "IKEA Food Services AB", "confidence": 0.93, "source": "claude"}
IKEA_URL = "https://www.ikea.com/mx/es/p/choklad-noet-tableta-chocolate-c-leche-con-avellanas-30524752/"
REQUEST = {"product": IKEA, "scanType": "both", "includeSimilar": False}


def page(url, verdict="verified", source="first_party", name="IKEA México"):
    return {"url": url, "title": "CHOKLAD NÖT 100 g", "retailerName": name, "sourceType": source,
            "verdict": verdict, "confidence": 0.9, "reason": "Same name and size"}


def turn(pages, seen=(), stop="end_turn"):
    """A web search turn: the tool call, its results (the URLs it saw), then the JSON answer."""
    return {"stop_reason": stop, "usage": {"input_tokens": 1000, "output_tokens": 200,
                                           "server_tool_use": {"web_search_requests": 2}},
            "content": [{"type": "text", "text": "Searching {first}."},
                        {"type": "server_tool_use", "name": "web_search", "input": {"query": "CHOKLAD NÖT"}},
                        {"type": "web_search_tool_result", "content": [{"type": "web_search_result", "url": u} for u in seen]},
                        {"type": "text", "text": json.dumps({"pages": pages, "similarProducts": []})}]}


def test_brand_domains_let_a_store_brand_through():
    assert brand_domain_guesses(IKEA)[:2] == ["ikea.com.mx", "ikea.com"]
    allowed = domain_policy(IKEA, "both")["allowed"]
    assert len(allowed) == len(set(allowed)), "the API refuses duplicate domains"
    assert "ikea.com" in allowed and "walmart.com.mx" in allowed
    assert "ikea.com" not in domain_policy(IKEA, "third_party")["allowed"]


def test_answer_is_checked_like_the_app_checks_it():
    found = parse_response(turn([
        page(IKEA_URL),
        page("https://www.walmart.com.mx/ip/choklad/123", name="Walmart", source="third_party"),   # never in results
        page("https://shop.example/p/choklad", source="third_party"),                              # not a known store
        page("https://evil.example/p/choklad"),                                                    # outside the policy
    ], seen=[IKEA_URL]), REQUEST)
    by_domain = {p["domain"]: p for p in found["pages"]}
    assert set(by_domain) == {"ikea.com", "walmart.com.mx"}
    assert by_domain["ikea.com"]["sourceType"] == "first_party" and by_domain["ikea.com"]["verification"]["status"] == "verified"
    walmart = by_domain["walmart.com.mx"]
    assert walmart["retailerName"] == "Walmart México" and walmart["verification"]["status"] == "uncertain"
    assert walmart["verification"]["confidence"] <= 0.5 and walmart["verification"]["reason"].startswith("Not seen")
    assert found["pages"][0]["domain"] == "ikea.com"   # the brand's own page ranks first


def test_empty_answer_is_retried_once_then_fails_with_a_reason():
    calls = []

    def post(body, timeout):
        calls.append(body)
        return turn([] if len(calls) == 1 else [page(IKEA_URL)], seen=[IKEA_URL])

    found = ClaudeSearch(Config(), post=post)(IKEA, REQUEST)
    assert len(calls) == 2 and "found no pages" in calls[1]["messages"][0]["content"]
    assert [p["domain"] for p in found["pages"]] == ["ikea.com"]
    assert found["recordedBy"].endswith("retried)") and found["run"]["usage"]["searches"] == 4
    tool = calls[0]["tools"][0]
    assert tool["type"] == web_search.TOOL_TYPE and tool["user_location"]["country"] == "MX" and "ikea.com" in tool["allowed_domains"]

    try:
        ClaudeSearch(Config(), post=lambda body, timeout: turn([]))(IKEA, REQUEST)
        raise AssertionError("expected no_results")
    except SearchError as exc:
        assert exc.code == "no_results" and "CHOKLAD NÖT" in str(exc) and len(exc.run["attempts"]) == 2


def test_pause_turn_continues_and_structured_output_falls_back():
    calls = []

    def post(body, timeout):
        calls.append(body)
        if "format" in body["output_config"]:
            raise SearchError("output_config.format is not supported with web_search", "bad_request")
        if len(calls) == 2:
            return {"stop_reason": "pause_turn", "content": [{"type": "server_tool_use", "name": "web_search"}], "usage": {}}
        return turn([page(IKEA_URL)], seen=[IKEA_URL])

    found = ClaudeSearch(Config(), post=post)(IKEA, REQUEST)
    assert [p["domain"] for p in found["pages"]] == ["ikea.com"]
    assert len(calls) == 3 and calls[2]["messages"][-1]["role"] == "assistant"


def test_search_job_saves_the_run_and_explains_no_pages(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    service.search.agent_search = ClaudeSearch(Config(), post=lambda body, timeout: turn([]))
    job = wait(service, service.post_search(REQUEST)[1]["jobId"])
    assert job["status"] == "failed" and job["error"].startswith("No store pages found for CHOKLAD NÖT")
    (run,) = service.store.all("search_runs")
    assert run["error"] and len(run["attempts"]) == 2

    service.search.agent_search = ClaudeSearch(Config(), post=lambda body, timeout: turn([page(IKEA_URL)], seen=[IKEA_URL]))
    job = wait(service, service.post_search(REQUEST)[1]["jobId"])
    (ikea,) = job["result"]["pages"]
    assert ikea["domain"] == "ikea.com" and "run" not in job["result"]


def test_a_connection_cut_mid_answer_is_retried_once(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    search = ClaudeSearch(Config(search_timeout=180))
    calls = []

    def flaky(request, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise SearchError("IncompleteRead", "transport")
        return {"ok": True}
    search._send = flaky
    assert search._post({"x": 1}, 180) == {"ok": True} and len(calls) == 2

    def broken(request, timeout):
        raise SearchError("IncompleteRead", "transport")
    search._send = broken
    with pytest.raises(SearchError) as cut:
        search._post({"x": 1}, 180)
    assert cut.value.code == "unreachable" and "broke off" in str(cut.value)

    def rejected(request, timeout):
        raise SearchError("bad", "bad_request")
    search._send = rejected
    with pytest.raises(SearchError) as bad:
        search._post({"x": 1}, 180)
    assert bad.value.code == "bad_request"   # the structured-output fallback depends on this code


TAKIS = {"id": "takis-fuego-56-g", "brand": "Takis", "productName": "Takis Fuego", "variant": "Fuego", "size": "56 g",
         "barcode": "7501030424536", "manufacturer": "Barcel"}
TAKIS_REQUEST = {"product": TAKIS, "scanType": "both", "includeSimilar": False}


def test_the_barcode_is_searched_and_counts_as_evidence():
    prompt = web_search.build_prompt(TAKIS_REQUEST)
    assert "7501030424536" in prompt and "00750103042453" in prompt
    ok = "https://super.walmart.com.mx/ip/takis-fuego-56-g/00750103042453"
    other = "https://super.walmart.com.mx/ip/takis-fuego-90-g/00750103042001"
    chedraui = "https://www.chedraui.com.mx/takis-fuego-56g-3224410/p"
    found = parse_response(turn([
        {**page(ok, "uncertain", "third_party", "Walmart"), "title": "Takis Fuego"},
        {**page(other, "verified", "third_party", "Walmart"), "title": "Takis Fuego"},
        {**page(chedraui, "verified", "third_party", "Chedraui"), "title": "Takis Fuego 90 g"},
    ], seen=[ok, other, chedraui]), TAKIS_REQUEST)
    status = {p["url"]: p["verification"] for p in found["pages"]}
    assert status[ok]["status"] == "verified" and status[ok]["confidence"] >= 0.95
    assert status[other]["status"] == "uncertain" and "another barcode" in status[other]["reason"]
    assert status[chedraui]["status"] == "uncertain" and "90 g" in status[chedraui]["reason"]


def test_sizes_are_read_and_compared():
    assert web_search.sizes_in("Coca-Cola 1.5 L y 600ml") == {("ml", 1500.0), ("ml", 600.0)}
    assert web_search.size_conflict("Takis Fuego 56 g", "56 g") is None
    assert web_search.size_conflict("Takis Fuego 56gr", "56 g") is None
    assert web_search.size_conflict("Takis Fuego 280 g", "56 g") == "280 g"
    assert web_search.size_conflict("Takis Fuego", "56 g") is None          # no size shown: nothing to say
    assert web_search.size_conflict("Leche 1 L", "1000 ml") is None


def test_link_check_drops_dead_links_and_downgrades_other_sizes():
    pages = [{"url": u, "matchType": "exact", "verification": {"status": "verified", "confidence": 0.9, "reason": "ok"}}
             for u in ("https://a.mx/p/1", "https://b.mx/p/2", "https://c.mx/p/3", "https://d.mx/p/4", "https://e.mx/p/5")]
    replies = {"https://a.mx/p/1": {"code": 404}, "https://b.mx/p/2": {"code": 200, "final": "https://b.mx/", "title": "Home"},
               "https://c.mx/p/3": {"code": 200, "final": "https://c.mx/p/3", "title": "Takis Fuego 90 g | C"},
               "https://d.mx/p/4": {"code": 403}}
    kept, counts = web_search.check_links(pages, TAKIS, may_fetch=lambda p: "e.mx" not in p["url"],
                                          fetch=lambda url: replies[url])
    assert [p["url"] for p in kept] == ["https://c.mx/p/3", "https://d.mx/p/4", "https://e.mx/p/5"]
    assert counts == {"dead": 2, "otherSize": 1}
    assert kept[0]["verification"]["status"] == "uncertain" and kept[1]["verification"]["status"] == "verified"


def test_similar_products_run_in_their_own_parallel_call():
    calls = []

    def post(body, timeout):
        calls.append(body)
        if "Find only similar products" in body["messages"][0]["content"]:
            assert body["model"] == web_search.SIMILAR_MODEL and body["tools"][0]["max_uses"] == web_search.SIMILAR_SEARCHES
            sim = {"brand": "IKEA", "productName": "IKEA CHOKLAD MÖRK", "variant": "", "relation": "same_brand",
                   "reason": "Dark", "pages": [page("https://www.ikea.com/mx/es/p/choklad-moerk-1/")]}
            return {**turn([], seen=["https://www.ikea.com/mx/es/p/choklad-moerk-1/"]),
                    "content": [{"type": "text", "text": json.dumps({"pages": [], "similarProducts": [sim]})}]}
        assert "Return an empty similarProducts list" in body["messages"][0]["content"]
        return turn([page(IKEA_URL)], seen=[IKEA_URL])

    found = ClaudeSearch(Config(), post=post)(IKEA, {**REQUEST, "includeSimilar": True})
    assert len(calls) == 2 and [s["productName"] for s in found["similarProducts"]] == ["IKEA CHOKLAD MÖRK"]
    assert {p["matchType"] for p in found["pages"]} == {"exact", "similar"}
    assert {a["part"] for a in found["run"]["attempts"]} == {"exact", "similar"}

    def broken_similar(body, timeout):
        if "Find only similar products" in body["messages"][0]["content"]:
            raise SearchError("busy", "rate_limited")
        return turn([page(IKEA_URL)], seen=[IKEA_URL])

    found = ClaudeSearch(Config(), post=broken_similar)(IKEA, {**REQUEST, "includeSimilar": True})
    assert [p["domain"] for p in found["pages"]] == ["ikea.com"] and found["run"]["similarError"] == "busy"


def test_recorded_takis_matches_the_real_scan_and_its_name():
    from server.search import FIXTURES, Search
    search = Search(Config(), kit=None, store=None, fixtures=FIXTURES)
    assert search.recorded({"barcode": "7501030424536"}) is not None          # the EAN a phone reads
    assert search.recorded({"barcode": "07501030424536"}) is not None
    assert search.recorded({"brand": "Takis", "productName": "TAKIS FUEGO", "size": "56 gr"}) is not None
    assert search.recorded({"brand": "Takis", "productName": "Takis Fuego", "size": "90 g"}) is None
    assert search.recorded({"barcode": "7501030424543"}) is None


def test_the_search_merges_into_the_stored_product(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    service.store.put("products", IKEA["id"], {**IKEA, "barcode": "7315122013887", "imageUrl": "https://x.example/i.jpg"})
    service.search.agent_search = ClaudeSearch(Config(), post=lambda body, timeout: turn([page(IKEA_URL)], seen=[IKEA_URL]))
    job = wait(service, service.post_search(REQUEST)[1]["jobId"])
    assert job["status"] == "succeeded"
    # the result keeps the id the app sent; it leads to the stored product through an alias
    stored = service.store.get("products", service.resolve_product_id(job["result"]["product"]["id"]))
    assert stored["barcode"] == "7315122013887"     # the scan without a barcode did not erase the known one
