"""A fake fetch that answers from a dict of URL -> (status, body), and a source built from a generic reader."""
import hashlib
from types import SimpleNamespace

from kit.source import check_source


class FakeFetch:
    def __init__(self, pages, robots=None, user_agent="ShelvinKit/0.1"):
        self.pages, self.robots, self.user_agent, self.asked = pages, robots, user_agent, []

    def allowed(self, url):
        return True, "fake"

    def __call__(self, request):
        self.asked.append(request["url"])
        status, body = self.pages.get(request["url"], (404, ""))
        return {"url": request["url"], "final_url": request["url"], "status": status,
                "sha256": hashlib.sha256(body.encode()).hexdigest(), "observed_at": "2026-10-29T00:00:00Z",
                "headers": {}, "body": body}


def make_source(functions, **declared):
    seeds, discover, check_detail, listings, page = functions
    values = {"SOURCE": "test_shop", "ORIGIN": "https://shop.example", "RETAILER": "Test Shop", "KIND": "third_party",
              "INTERVAL": 1, "CURRENCY": "MXN", **declared}
    return check_source(SimpleNamespace(seeds=seeds, discover=discover, check_detail=check_detail, listings=listings,
                                        page=page, **values))
