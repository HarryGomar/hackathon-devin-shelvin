"""A throwaway copy of scraper-kit per test, a fake robots.txt, and a scripted builder that writes a VTEX source."""
import hashlib
import importlib.util
import json
import shutil
import time
from pathlib import Path

import pytest

from server.app import Service
from server.config import Config
from server.kit import Kit
from server.runners import ScriptedRunner

REPO = Path(__file__).resolve().parents[2]
O = "https://shop.example"
PAGE = f"{O}/botana-barcel-takis-fuego-56g-3090610/p"
API = f"{O}/api/catalog_system/pub/products/search/botana-barcel-takis-fuego-56g-3090610/p"
VTEX_PRODUCT = [{
    "productId": "3090610", "productName": "Botana Barcel Takis Fuego 56g", "brand": "Takis",
    "linkText": "botana-barcel-takis-fuego-56g-3090610", "categories": ["/Despensa/Botanas/Papas y frituras/"],
    "items": [{"itemId": "3090610", "name": "Takis Fuego 56g", "nameComplete": "Botana Barcel Takis Fuego 56g",
               "ean": "0750103042453", "images": [{"imageUrl": f"{O}/arquivos/ids/1.jpg"}],
               "sellers": [{"sellerName": "Shop", "commertialOffer": {"Price": 18.5, "ListPrice": 19.0,
                                                                     "AvailableQuantity": 40, "IsAvailable": True}}]}],
}]
SOURCE_TEXT = f'''"""Shop (shop.example): generic vtex reader."""
from kit.generic import vtex

SOURCE = "shop_mx"
ORIGIN = "{O}"
RETAILER = "Shop"
KIND = "third_party"
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "{PAGE}"

page_request, page = vtex.bind(ORIGIN, CURRENCY)
'''
ROBOTS = {
    O: "User-agent: *\nDisallow: /cart\n",
    "https://www.amazon.com.mx": "User-agent: *\nDisallow: /cart\n\nUser-agent: ClaudeBot\nDisallow: /\n",
    "https://other.example": "User-agent: *\nAllow: /\n",
}
TAKIS = {"id": "takis-fuego-56g", "brand": "Takis", "productName": "Takis Fuego", "size": "56 g",
         "barcode": "0750103042453", "confidence": 0.9, "source": "claude"}


class FakeFetch:
    robots, user_agent = None, "ShelvinKit/0.1"

    def __init__(self, pages):
        self.pages = pages

    def __call__(self, request):
        status, body = self.pages.get(request["url"], (404, ""))
        return {"url": request["url"], "final_url": request["url"], "status": status,
                "sha256": hashlib.sha256(body.encode()).hexdigest(), "observed_at": "2026-10-29T00:00:00Z",
                "headers": {}, "body": body}


def write_source(workspace, *, written_by="scripted builder: read from capture bodies", title=None):
    """What a builder leaves: sources/shop_mx.py and fixtures/shop_mx/ (capture and expected.json)."""
    workspace = Path(workspace)
    (workspace / "sources" / "shop_mx.py").write_text(SOURCE_TEXT, encoding="utf-8")
    from kit import capture   # importable once a Kit is made
    spec = importlib.util.spec_from_file_location("shop_mx_draft", workspace / "sources" / "shop_mx.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    saved, rows = capture.collect_page(module, PAGE, fetch=FakeFetch({API: (200, json.dumps(VTEX_PRODUCT))}))
    folder = workspace / "fixtures" / "shop_mx"
    capture.save(saved, folder / "capture.json")
    expected = {"rows": len(rows), "spot": [{"native_id": "3090610", "title": title or "Botana Barcel Takis Fuego 56g",
                                             "price": {"amount": 18.5, "currency": "MXN"}}], "written_by": written_by}
    (folder / "expected.json").write_text(json.dumps(expected), encoding="utf-8")
    return {"stage": "done", "attempt": 1, "outcome": "built_no_pr", "source": "shop_mx", "host": "shop.example",
            "kind": "third_party", "reader": "vtex", "rows": len(rows), "branch": None, "pr_url": None, "notes": ""}


@pytest.fixture
def kit_copy(tmp_path):
    target = tmp_path / "scraper-kit"
    shutil.copytree(REPO / "scraper-kit", target, ignore=shutil.ignore_patterns(".venv", "__pycache__", ".pytest_cache", "captures"))
    return target


def make_service(tmp_path, kit_copy, steps, **config):
    kit = Kit(kit_copy)
    kit.fetch_robots = lambda origin: (200, ROBOTS[origin]) if origin in ROBOTS else (404, "")
    kit.probe = lambda url: {"access": kit.access(url), "platform": "vtex", "reader": "vtex", "notes": []}
    runner = ScriptedRunner(kit, steps)
    service = Service(Config(data_dir=tmp_path / "data", kit_dir=kit_copy, agent="scripted", **{"database_url": "", **config}), kit=kit,
                      runner=runner, scrape_fetch=lambda module: FakeFetch({API: (200, json.dumps(VTEX_PRODUCT))}))
    service.builds.live_gate = False
    service.search.HOLD_SECONDS = 0          # no on-screen pauses in tests
    service.search.photo = lambda product: product   # and no Open Food Facts calls
    service.builds.unreachable_wait = 0
    fixtures = tmp_path / "search"
    fixtures.mkdir()
    (fixtures / "takis.json").write_text(json.dumps({
        "match": {"barcodes": ["750103042453"], "names": []}, "recordedBy": "test",
        "pages": [
            {"url": PAGE, "retailerName": "Shop", "sourceType": "third_party", "title": "Takis Fuego 56g",
             "verification": {"status": "verified", "confidence": 0.95, "reason": "Same name, size and barcode"}},
            {"url": "https://www.amazon.com.mx/s?k=takis+fuego", "retailerName": "Amazon México",
             "sourceType": "third_party", "title": "Takis Fuego on Amazon"},
            {"url": "https://other.example/p/takis", "retailerName": "Other", "sourceType": "third_party",
             "title": "Takis at Other"},
        ]}), encoding="utf-8")
    service.search.fixtures = fixtures
    return service, runner


def wait(service, job_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        view = service.jobs.get(job_id).view()
        if view["status"] in ("succeeded", "failed"):
            return view
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} still running")
