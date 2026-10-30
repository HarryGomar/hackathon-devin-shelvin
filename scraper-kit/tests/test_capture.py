"""The collector's own rules: loops, foreign URLs, replay drift and row checks."""
import pytest

from kit import capture, rows
from kit.http import Http, Refused
from tests.helpers import FakeFetch, make_source

O = "https://shop.example"


def paged(loop=False):
    def seeds():
        return [{"url": f"{O}/list?p=1"}]

    def discover(response, request):
        n = int(request["url"].rsplit("=", 1)[1])
        nxt = 1 if loop and n == 2 else n + 1
        return [{"id": f"p{n}", "request": None}], ([{"url": f"{O}/list?p={nxt}"}] if n < 3 or loop else [])

    def listings(saved):
        return [rows.row(f"p{i + 1}", f"{O}/item/{i + 1}", title=page["body"]) for i, page in enumerate(saved["pages"])]

    return seeds, discover, None, listings, None


def test_pagination_that_loops_fails_the_capture():
    pages = {f"{O}/list?p={n}": (200, f"page {n}") for n in (1, 2, 3)}
    with pytest.raises(ValueError, match="pagination loops"):
        capture.collect(make_source(paged(loop=True)), fetch=FakeFetch(pages))


def test_page_ceiling_is_a_named_bound():
    pages = {f"{O}/list?p={n}": (200, f"page {n}") for n in (1, 2, 3)}
    saved, found = capture.collect(make_source(paged()), fetch=FakeFetch(pages), max_pages=2)
    assert saved["status"]["bounds"] == ["2 pages"] and len(found) == 2
    assert capture.replay(saved, make_source(paged())) == found


def test_replay_fails_when_a_saved_page_is_not_what_discovery_asks_next():
    pages = {f"{O}/list?p={n}": (200, f"page {n}") for n in (1, 2, 3)}
    module = make_source(paged())
    saved, _ = capture.collect(module, fetch=FakeFetch(pages))
    saved["pages"][1]["url"] = f"{O}/list?p=9"
    with pytest.raises(ValueError, match="discovery asks for"):
        capture.replay(saved, module)


def test_rows_must_be_exactly_the_discovered_items():
    seeds, discover, _, _, _ = paged()
    pages = {f"{O}/list?p={n}": (200, f"page {n}") for n in (1, 2, 3)}

    def short(saved):
        return [rows.row("p1", f"{O}/item/1")]

    with pytest.raises(ValueError, match="rows are not the discovered items"):
        capture.collect(make_source((seeds, discover, None, short, None)), fetch=FakeFetch(pages))


def test_row_shape_is_enforced():
    good = rows.row("1", f"{O}/a", price=rows.money("21.50", "MXN"), fields={"net_weight": "62 g"})
    assert rows.check_rows([good])
    for bad in ({**good, "fields": {"nested": {"no": 1}}}, {**good, "price": {"amount": "21", "currency": "MXN"}},
                {**good, "url": "http://shop.example/a"}, {**good, "extra": 1}):
        with pytest.raises(ValueError):
            rows.check_rows([bad])
    with pytest.raises(ValueError, match="repeats"):
        rows.check_rows([good, good])


def test_http_refuses_another_origin_before_sending():
    fetch = Http(O, 1, check_robots=False)
    with pytest.raises(Refused, match="outside"):
        fetch({"url": "https://evil.example/x"})
