"""The probe picks a generic reader, and the source file it writes is a valid source."""
import json
import types

from kit import probe
from kit.source import check_source
from tests.helpers import FakeFetch
from tests.test_generic import TAKIS, ld_page

O = "https://shop.example"


def _module(text):
    module = types.ModuleType("probed")
    exec(compile(text, "probed.py", "exec"), module.__dict__)
    return check_source(module)


def test_shopify_store_becomes_a_one_line_source():
    fetch = FakeFetch({f"{O}/products.json?limit=1": (200, json.dumps({"products": []})),
                       f"{O}/products/takis": (200, ld_page("/products/takis", TAKIS))})
    report = probe.probe(f"{O}/products/takis", fetch=fetch)
    assert report["reader"] == "shopify" and report["row"]["title"] == "Takis Fuego 56 g"
    module = _module(probe.source_text(report, "shop_mx", "Shop", "first_party", ("Barcel",)))
    assert module.seeds() == [{"url": f"{O}/products.json?limit=250&page=1"}]


def _jsonld_report():
    fetch = FakeFetch({f"{O}/products.json?limit=1": (404, "not found"), f"{O}/jsonapi": (404, ""),
                       f"{O}/productos/takis-fuego-56g": (200, ld_page("/productos/takis-fuego-56g", TAKIS))})
    return probe.probe(f"{O}/productos/takis-fuego-56g", fetch=fetch)


def test_a_retailer_gets_a_page_only_source():
    report = _jsonld_report()
    assert report["reader"] == "jsonld"
    module = _module(probe.source_text(report, "shop_mx", "Shop", "third_party"))
    assert not hasattr(module, "seeds") and module.SAMPLE_PAGE == f"{O}/productos/takis-fuego-56g"
    (row,) = module.page({"url": module.SAMPLE_PAGE, "body": ld_page("/productos/takis-fuego-56g", TAKIS)})
    assert row["title"] == "Takis Fuego 56 g"


def test_a_brand_site_with_jsonld_gets_a_sitemap_source_with_the_page_pattern():
    report = _jsonld_report()
    module = _module(probe.source_text(report, "shop_mx", "Shop", "first_party", ("Barcel",)))
    assert module.seeds() == [{"url": f"{O}/sitemap.xml"}]
    items, _ = module.discover({"body": f"<urlset><url><loc>{O}/productos/otro</loc></url>"
                                        f"<url><loc>{O}/nosotros</loc></url></urlset>"}, None)
    assert [i["id"] for i in items] == ["/productos/otro"]


def test_the_report_names_missing_fields_and_absolute_sitemaps():
    no_barcode = {k: v for k, v in TAKIS.items() if k != "gtin13"}
    fetch = FakeFetch({f"{O}/products.json?limit=1": (404, ""), f"{O}/jsonapi": (404, ""),
                       f"{O}/productos/takis": (200, ld_page("/productos/takis", no_barcode))},
                      robots={"status": 200, "body": "User-agent: *\nAllow: /\nSitemap: /es/sitemap.xml\n"})
    report = probe.probe(f"{O}/productos/takis", fetch=fetch)
    assert report["missing"] == ["barcode"]
    assert report["sitemaps"] == [f"{O}/es/sitemap.xml"]


def test_nothing_fits_says_build_one():
    fetch = FakeFetch({f"{O}/products.json?limit=1": (404, ""), f"{O}/jsonapi": (404, ""),
                       f"{O}/p/1": (200, "<html>app shell</html>")})
    report = probe.probe(f"{O}/p/1", fetch=fetch)
    assert report["reader"] is None and any("build a source" in n for n in report["notes"])
