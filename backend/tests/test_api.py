"""The HTTP layer and the scrape job, end to end on a throwaway kit."""
import json
import threading
import time
import urllib.error
import urllib.request

from server.app import handler_for
from tests.conftest import TAKIS, make_service, wait, write_source
from http.server import ThreadingHTTPServer


def test_scrape_reads_built_sources_and_reports_refusals_per_site(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [lambda w, m: write_source(w)])
    job = service.post_search({"product": TAKIS, "scanType": "both", "includeSimilar": False, "region": "MX"})[1]
    pages = wait(service, job["jobId"])["result"]["pages"]
    shop = next(p for p in pages if p["domain"] == "shop.example")
    wait(service, service.post_build({"url": shop["url"], "pageId": shop["id"]})[1]["jobId"])
    ids = [p["id"] for p in pages if p["domain"] in ("shop.example", "amazon.com.mx")]
    view = wait(service, service.post_scrape({"searchId": "s", "productId": TAKIS["id"], "pageIds": ids})[1]["jobId"])
    result = view["result"]
    (listing,) = result["listings"]
    assert listing["price"] == {"amount": 18.5, "currency": "MXN"} and listing["fields"]["barcode"] == "0750103042453"
    assert listing["standardTaxonomy"]["path"][-1] == "Chips"
    (failure,) = result["failures"]
    assert failure["code"] == "ai_opt_out"
    states = {s["domain"]: s["state"] for s in view["sites"]}
    assert states == {"shop.example": "done", "amazon.com.mx": "refused"}
    assert service.get_listings(TAKIS["id"])[1]["listings"][0]["title"] == "Botana Barcel Takis Fuego 56g"
    assert service.get_scans()[1]["scans"][0]["listingCount"] == 1


def test_http_errors_use_the_contract_shape(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(service))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(f"{base}/health") as response:
            assert json.loads(response.read())["ok"] is True
        request = urllib.request.Request(f"{base}/scrapers/build", data=b'{"url": "not a url"}', method="POST",
                                         headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(request)
            raise AssertionError("expected 400")
        except urllib.error.HTTPError as exc:
            assert exc.code == 400
            body = json.loads(exc.read())
            assert body["code"] == "invalid_url" and isinstance(body["error"], str)
        try:
            urllib.request.urlopen(f"{base}/jobs/nope")
        except urllib.error.HTTPError as exc:
            assert exc.code == 404
    finally:
        server.shutdown()


def test_a_brand_catalog_matches_when_the_phone_names_the_maker(tmp_path, kit_copy):
    """Barcel's own catalog lists brand "Takis"; the phone may identify the brand as "Barcel" (the maker)."""
    saved = json.loads((kit_copy / "fixtures" / "barcel_mx" / "capture.json").read_text(encoding="utf-8"))
    bodies = {p["url"]: p for p in saved["pages"]}
    first = saved["pages"][0]
    # The capture holds the first page only; a later page answers with no products, which ends the catalog.
    replay = lambda request: bodies.get(request["url"]) or {**first, "url": request["url"], "final_url": request["url"],
                                                             "body": json.dumps({"data": [], "links": {}})}
    service, _ = make_service(tmp_path, kit_copy, [])
    service.scrape.fetch_for = lambda module: replay
    service.kit.robots_cache["https://www.barcel.com.mx"] = (time.time(), 200, "User-agent: *\nAllow: /\n")
    product = {**TAKIS, "brand": "Barcel"}
    service.store.put("products", product["id"], product)
    service.store.put("pages", "pg-barcel", {"id": "pg-barcel", "url": "https://www.barcel.com.mx/takis",
                                             "domain": "barcel.com.mx", "retailerName": "Barcel", "sourceType": "first_party"})
    view = wait(service, service.post_scrape({"productId": product["id"], "pageIds": ["pg-barcel"]})[1]["jobId"])
    (listing,) = view["result"]["listings"]
    assert listing["title"].startswith("Takis Fuego") and view["result"]["failures"] == []
