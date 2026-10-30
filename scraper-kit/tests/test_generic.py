"""The generic readers over small hand-written pages. Expected values are read off the bodies below, not the code."""
import json

import pytest

from kit import capture
from kit.generic import jsonld, og, page, shopify
from tests.helpers import FakeFetch, make_source

O = "https://shop.example"


def products_page(products):
    return json.dumps({"products": products})


def shop_product(pid, handle, variants, vendor="Sabritas", product_type="Botanas"):
    return {"id": pid, "handle": handle, "title": handle.replace("-", " ").title(), "vendor": vendor,
            "product_type": product_type, "tags": ["picante", "maiz"], "images": [{"src": f"{O}/img/{pid}.jpg"}],
            "options": [{"name": "Tamaño"}], "variants": variants}


def variant(vid, title, price, barcode="", available=True):
    return {"id": vid, "title": title, "price": price, "sku": f"SKU{vid}", "barcode": barcode, "grams": 62,
            "available": available, "featured_image": None}


def test_shopify_pages_until_a_short_page_and_one_row_per_variant():
    module = make_source(shopify.bind(O, "MXN", limit=2))
    pages = {
        f"{O}/products.json?limit=2&page=1": (200, products_page([
            shop_product(1, "doritos-incognita", [variant(11, "62 g", "21.50", "7500000000017"),
                                                  variant(12, "150 g", "45.00", available=False)]),
            shop_product(2, "doritos-nacho", [variant(21, "Default Title", "21.00")])])),
        f"{O}/products.json?limit=2&page=2": (200, products_page([
            shop_product(3, "ruffles-queso", [variant(31, "Default Title", "0")])])),
    }
    saved, rows = capture.collect(module, fetch=FakeFetch(pages))
    assert saved["status"] == {"items": 4, "details": 0, "rows": 4, "bounds": [], "complete": True}
    by_id = {r["native_id"]: r for r in rows}
    assert by_id["11"]["title"] == "Doritos Incognita - 62 g"
    assert by_id["11"]["url"] == f"{O}/products/doritos-incognita?variant=11"
    assert by_id["11"]["price"] == {"amount": 21.5, "currency": "MXN"}
    assert by_id["11"]["barcode"] == "7500000000017"
    assert by_id["12"]["available"] is False
    assert by_id["21"]["url"] == f"{O}/products/doritos-nacho"
    assert by_id["31"]["price"] is None   # a 0 price is unknown, not free
    assert by_id["11"]["fields"]["tags"] == '["picante", "maiz"]'
    assert by_id["11"]["fields"]["variant_grams"] == 62
    assert capture.replay(saved, module) == rows


def test_shopify_refuses_an_error_page():
    module = make_source(shopify.bind(O, "MXN"))
    with pytest.raises(ValueError, match="not a products.json page"):
        capture.collect(module, fetch=FakeFetch({f"{O}/products.json?limit=250&page=1": (200, "<html>Oops</html>")}))


SITEMAP_INDEX = f"""<?xml version="1.0"?><sitemapindex><sitemap><loc>{O}/sitemap-products.xml</loc></sitemap>
<sitemap><loc>{O}/sitemap-pages.xml</loc></sitemap></sitemapindex>"""
SITEMAP_PRODUCTS = f"""<urlset><url><loc>{O}/productos/takis-fuego-56g</loc></url>
<url><loc><![CDATA[{O}/productos/pi%C3%B1a-enchilada]]></loc></url><url><loc>{O}/productos/takis-fuego-56g</loc></url></urlset>"""
SITEMAP_PAGES = f"<urlset><url><loc>{O}/contacto</loc></url></urlset>"


def ld_page(path, data, canonical=True):
    link = f'<link rel="canonical" href="{O}{path}">' if canonical else ""
    return f'<html><head>{link}<script type="application/ld+json">{json.dumps(data)}</script></head></html>'


TAKIS = {"@context": "https://schema.org", "@type": "Product", "name": "Takis Fuego 56 g", "brand": {"@type": "Brand", "name": "Barcel"},
         "gtin13": "7501030400019", "sku": "TF56", "image": [f"{O}/img/takis.jpg"], "category": "Botanas > Totopos",
         "offers": {"@type": "Offer", "price": "18.00", "priceCurrency": "MXN", "availability": "https://schema.org/InStock"},
         "aggregateRating": {"ratingValue": 4.7, "reviewCount": 210}}
PINA_GROUP = {"@type": "ProductGroup", "name": "Piña enchilada", "brand": "Barcel", "hasVariant": [
    {"@type": "Product", "name": "Piña enchilada 40 g", "url": f"{O}/productos/piña-enchilada",
     "offers": {"price": 12, "priceCurrency": "MXN", "availability": "https://schema.org/OutOfStock"}},
    {"@type": "Product", "name": "Piña enchilada 100 g", "url": f"{O}/productos/piña-enchilada-100"}]}


def jsonld_pages():
    return {
        f"{O}/sitemap.xml": (200, SITEMAP_INDEX),
        f"{O}/sitemap-products.xml": (200, SITEMAP_PRODUCTS),
        f"{O}/sitemap-pages.xml": (200, SITEMAP_PAGES),
        f"{O}/productos/takis-fuego-56g": (200, ld_page("/productos/takis-fuego-56g", TAKIS)),
        f"{O}/productos/pi%C3%B1a-enchilada": (200, ld_page("/productos/piña-enchilada", PINA_GROUP, canonical=False)),
    }


def test_jsonld_sitemap_index_products_and_group_variants():
    module = make_source(jsonld.bind(O, "/sitemap.xml", r"/productos/[^/]+", "MXN"), KIND="first_party", BRANDS=("Barcel",))
    saved, rows = capture.collect(module, fetch=FakeFetch(jsonld_pages()))
    assert saved["status"]["items"] == 2 and saved["status"]["complete"]
    takis, pina = sorted(rows, key=lambda r: r["native_id"], reverse=True)
    assert takis["native_id"] == "/productos/takis-fuego-56g"
    assert (takis["title"], takis["brand"], takis["barcode"], takis["sku"]) == ("Takis Fuego 56 g", "Barcel", "7501030400019", "TF56")
    assert takis["price"] == {"amount": 18.0, "currency": "MXN"} and takis["available"] is True
    assert takis["category_path"] == ["Botanas", "Totopos"]
    assert takis["image_url"] == f"{O}/img/takis.jpg"
    assert takis["fields"]["aggregate_rating_rating_value"] == 4.7
    assert pina["native_id"] == "/productos/piña-enchilada"
    assert (pina["title"], pina["brand"], pina["available"]) == ("Piña enchilada 40 g", "Barcel", False)
    assert pina["url"] == f"{O}/productos/pi%C3%B1a-enchilada"
    assert capture.replay(saved, module) == rows


def test_jsonld_detail_that_is_another_page_stops_the_run():
    module = make_source(jsonld.bind(O, "/sitemap.xml", r"/productos/[^/]+", "MXN"))
    pages = jsonld_pages()
    pages[f"{O}/productos/takis-fuego-56g"] = (200, ld_page("/productos/otra-cosa", TAKIS))
    with pytest.raises(ValueError, match="detail is not product page"):
        capture.collect(module, fetch=FakeFetch(pages))


def test_bounded_capture_replays_and_unbounded_gap_fails():
    module = make_source(jsonld.bind(O, "/sitemap.xml", r"/productos/[^/]+", "MXN"))
    saved, rows = capture.collect(module, fetch=FakeFetch(jsonld_pages()), max_items=1)
    assert saved["status"]["bounds"] == ["1 items"] and len(rows) == 1
    assert capture.replay(saved, module) == rows
    saved["status"]["bounds"] = []
    with pytest.raises(ValueError, match="no saved detail"):
        capture.replay(saved, module)


OG_PAGE = f"""<html><head><link rel="canonical" href="{O}/producto/rancheritos">
<meta property="og:title" content="Rancheritos 52 g"><meta property="og:image" content="{O}/img/r.jpg">
<meta property="product:price:amount" content="17.00"><meta property="product:price:currency" content="MXN">
<meta property="product:availability" content="in stock"><meta property="product:brand" content="Sabritas">
<meta name="keywords" content="botana"><meta name="keywords" content="chile"></head><body><h1>Rancheritos</h1></body></html>"""


def test_open_graph_reader_keeps_every_meta_tag():
    module = make_source(og.bind(O, "/sitemap.xml", r"/producto/[^/]+", "MXN"))
    pages = {f"{O}/sitemap.xml": (200, f"<urlset><url><loc>{O}/producto/rancheritos</loc></url></urlset>"),
             f"{O}/producto/rancheritos": (200, OG_PAGE)}
    saved, rows = capture.collect(module, fetch=FakeFetch(pages))
    (row,) = rows
    assert (row["title"], row["brand"], row["available"]) == ("Rancheritos 52 g", "Sabritas", True)
    assert row["price"] == {"amount": 17.0, "currency": "MXN"}
    assert row["fields"]["keywords"] == '["botana", "chile"]' and row["fields"]["h1"] == "Rancheritos"
    assert capture.replay(saved, module) == rows


def test_a_relative_image_becomes_an_absolute_url():
    # Office Depot's JSON-LD and Open Graph images are paths.
    found = page.read({"url": f"{O}/productos/takis-fuego-56g",
                       "body": ld_page("/productos/takis-fuego-56g", {**TAKIS, "image": "/medias/takis.jpg"})})
    assert found[0]["image_url"] == f"{O}/medias/takis.jpg"
    og_page = OG_PAGE.replace(f'content="{O}/img/r.jpg"', 'content="/img/r.jpg"')
    assert page.read({"url": f"{O}/producto/rancheritos", "body": og_page})[0]["image_url"] == f"{O}/img/r.jpg"


def test_page_reader_prefers_jsonld_then_open_graph_and_refuses_an_empty_page():
    response = {"url": f"{O}/productos/takis-fuego-56g", "body": ld_page("/productos/takis-fuego-56g", TAKIS)}
    assert page.read(response)[0]["fields"]["reader"] == "jsonld"
    assert page.read({"url": f"{O}/producto/rancheritos", "body": OG_PAGE})[0]["fields"]["reader"] == "open_graph"
    with pytest.raises(ValueError, match="no readable product"):
        page.read({"url": f"{O}/x", "body": "<html><title>Access denied</title></html>"})


def test_a_relative_image_becomes_an_absolute_url():
    body = ('<script type="application/ld+json">{"@type": "Product", "name": "Takis Fuego 56 gr", "image": '
            '"/medias/96ftw.jpg?context=x", "offers": {"price": "22.0", "priceCurrency": "MXN"}}</script>')
    (row,) = page.read({"url": "https://www.officedepot.com.mx/p/100275440", "body": body})
    assert row["image_url"] == "https://www.officedepot.com.mx/medias/96ftw.jpg?context=x"
    og_body = '<meta property="og:title" content="Takis"><meta property="og:image" content="/img/t.jpg"><meta property="product:price:amount" content="22">'
    (row,) = page.read({"url": "https://shop.example/p/1", "body": og_body}, "MXN")
    assert row["image_url"] == "https://shop.example/img/t.jpg"
