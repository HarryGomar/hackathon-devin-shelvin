"""docs/backend-spec.md over HTTP: errors, auth, CORS, body cap, daily caps, health; search ids, cache and steps;
scrape failures and the merge by pageId on the JSON store."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from server.app import handler_for
from server.search import page_id_for
from tests.conftest import PAGE, TAKIS, make_service, wait, write_source


@pytest.fixture
def served(tmp_path, kit_copy, monkeypatch):
    def start(token=None, **config):
        if token:
            monkeypatch.setenv("API_TOKEN", token)
        else:
            monkeypatch.delenv("API_TOKEN", raising=False)
        service, runner = make_service(tmp_path, kit_copy, [lambda w, m: write_source(w)], **config)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(service))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return service, f"http://127.0.0.1:{server.server_address[1]}"
    servers = []
    yield start
    for server in servers:
        server.shutdown()


def call(base, method, path, body=None, token=None, headers=None, raw=None):
    h = {**({"Authorization": f"Bearer {token}"} if token else {}), **(headers or {})}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if data is not None:
        h.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read()
            return response.status, json.loads(text) if text else None, response.headers
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"null"), exc.headers


def test_errors_are_flat_strings_with_codes(served):
    _, base = served()
    for method, path, body, status, code in [
        ("GET", "/jobs/nope", None, 404, "not_found"),
        ("GET", "/no/such/route", None, 404, "not_found"),
        ("GET", "/products/nope/listings", None, 404, "not_found"),
        ("POST", "/search", {}, 400, "invalid_request"),
        ("POST", "/scrapers/build", {"url": "not a url"}, 400, "invalid_url"),
        ("POST", "/scrape", {"productId": "x"}, 400, "invalid_request"),
        ("POST", "/scrapers/match", {"urls": "x"}, 400, "invalid_request"),
    ]:
        got, out, _ = call(base, method, path, body)
        assert (got, out["code"]) == (status, code), path
        assert isinstance(out["error"], str) and out["error"]
    got, out, _ = call(base, "POST", "/search", raw=b"{not json")
    assert (got, out["code"]) == (400, "invalid_request")


def test_token_is_required_everywhere_but_health(served):
    _, base = served(token="s3cret")
    status, out, _ = call(base, "GET", "/health")
    assert status == 200 and out["ok"] is True and isinstance(out["version"], str)
    for token in (None, "wrong"):
        status, out, _ = call(base, "GET", "/scans", token=token)
        assert (status, out["code"]) == (401, "unauthorized")
    status, out, _ = call(base, "POST", "/search", {"product": TAKIS}, token="wrong")
    assert status == 401
    assert call(base, "GET", "/scans", token="s3cret")[0] == 200


def test_no_token_configured_means_auth_off(served):
    _, base = served()
    assert call(base, "GET", "/scans")[0] == 200


def test_cors_preflight(served):
    _, base = served(token="s3cret")
    status, _, headers = call(base, "OPTIONS", "/search", headers={"Origin": "http://localhost:8081",
                                                                  "Access-Control-Request-Method": "POST"})
    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert "Authorization" in headers["Access-Control-Allow-Headers"]
    assert "POST" in headers["Access-Control-Allow-Methods"]


def test_body_over_the_cap_is_413(served):
    _, base = served(max_body_bytes=1000)
    status, out, _ = call(base, "POST", "/search", raw=b'{"x": "' + b"a" * 2000 + b'"}')
    assert (status, out["code"]) == (413, "too_large")


def test_daily_search_cap_answers_429_over_budget(served):
    service, base = served(max_searches_per_day=1)
    service.search.agent_search = lambda product, request: {"pages": [{"url": "https://other.example/p/1",
                                                                       "retailerName": "Other", "title": "x"}]}
    unknown = {"id": "x-1", "brand": "X", "productName": "X One", "confidence": 0.5, "source": "claude"}
    status, job, _ = call(base, "POST", "/search", {"product": unknown})
    assert status == 202
    wait(service, job["jobId"])
    # the same product again is cached: free, so not counted
    assert call(base, "POST", "/search", {"product": unknown})[0] == 202
    other = {**unknown, "id": "x-2", "productName": "X Two"}
    status, out, _ = call(base, "POST", "/search", {"product": other})
    assert (status, out["code"]) == (429, "over_budget")
    # a recorded search costs nothing and still runs
    assert call(base, "POST", "/search", {"product": TAKIS})[0] == 202


def test_search_steps_ids_and_refused_pages(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    seen = []
    original = service.search.run

    def spy(job, request, search_id):
        step = job.step

        def record(name, message, percent=None):
            seen.append(name)
            step(name, message, percent)
        job.step = record
        return original(job, request, search_id)
    service.search.run = spy
    view = wait(service, service.post_search({"product": TAKIS, "scanType": "both", "includeSimilar": False})[1]["jobId"])
    assert [s for i, s in enumerate(seen) if i == 0 or seen[i - 1] != s] == ["search", "verify", "rank", "done"]
    pages = view["result"]["pages"]
    assert next(p for p in pages if p["url"] == PAGE)["id"] == page_id_for(PAGE)
    again = wait(service, service.post_search({"product": TAKIS})[1]["jobId"])["result"]["pages"]
    assert {p["id"] for p in again} == {p["id"] for p in pages}, "page ids are stable per URL"
    amazon = next(p for p in pages if p["domain"] == "amazon.com.mx")
    assert amazon["access"]["status"] == "refused" and amazon["scraper"]["status"] != "available"


def test_scrape_merges_by_page_and_keeps_failures_until_a_listing(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [lambda w, m: write_source(w)])
    pages = wait(service, service.post_search({"product": TAKIS})[1]["jobId"])["result"]["pages"]
    shop = next(p for p in pages if p["domain"] == "shop.example")
    other = next(p for p in pages if p["domain"] == "other.example")
    wait(service, service.post_build({"url": shop["url"], "pageId": shop["id"]})[1]["jobId"])
    first = wait(service, service.post_scrape({"productId": TAKIS["id"], "pageIds": [shop["id"], other["id"], "ghost"]})[1]["jobId"])
    assert first["status"] == "succeeded"
    failures = {f["pageId"]: f for f in first["result"]["failures"]}
    assert failures[other["id"]]["code"] == "no_scraper" and failures[other["id"]]["retailerName"] == "Other"
    assert "ghost" in failures, "an unknown page is a failure, not a failed job"
    second = wait(service, service.post_scrape({"productId": TAKIS["id"], "pageIds": [shop["id"]]})[1]["jobId"])
    saved = service.get_listings(TAKIS["id"])[1]
    assert [l["pageId"] for l in saved["listings"]] == [shop["id"]], "one listing per page"
    assert saved["listings"][0]["scrapedAt"] == second["result"]["listings"][0]["scrapedAt"]
    assert [f["pageId"] for f in saved["failures"]] == [other["id"]]
    assert service.get_scans()[1]["scans"][0]["listingCount"] == 1


def test_a_phone_local_photo_is_never_shared(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    product = {**TAKIS, "imageUrl": "file:///var/mobile/photo.jpg", "imageSource": "user_photo"}
    result = wait(service, service.post_search({"product": product})[1]["jobId"])["result"]
    assert result["product"]["imageSource"] == "user_photo", "the searching phone gets its product back as sent"
    assert "imageUrl" not in service.store.get("products", TAKIS["id"])
