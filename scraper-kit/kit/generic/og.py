"""Sites whose product pages carry no JSON-LD Product, only meta tags such as Open Graph and a canonical link.

Discovery is the same product sitemap as `jsonld`; every meta tag with a name and a
content is kept in `fields` (`og:title` -> `og_title`), a repeated tag as a JSON list.

    from kit.generic import og
    seeds, discover, check_detail, listings, page = og.bind(ORIGIN, "/sitemap.xml", r"/producto/[^/]+/?", CURRENCY)
"""
import json
from urllib.parse import quote

from .. import rows as kit_rows
from . import markup


def _first(tags, *names):
    for name in names:
        if tags.get(name) and tags[name][0].strip():
            return " ".join(tags[name][0].split())
    return None


def to_row(body, url, currency=None):
    tags = markup.meta(body)
    available = _first(tags, "product:availability", "og:availability", "availability")
    fields = {kit_rows.snake(k): (v[0] if len(v) == 1 else json.dumps(v, ensure_ascii=False)) for k, v in tags.items()}
    fields["h1"] = markup.h1(body)
    return kit_rows.row(
        markup.path_of(url) or url, url,
        title=_first(tags, "og:title", "twitter:title") or markup.h1(body),
        brand=_first(tags, "product:brand", "og:brand", "brand"),
        barcode=_first(tags, "product:upc", "product:ean", "gtin13", "gtin"),
        sku=_first(tags, "product:retailer_item_id", "sku"),
        price=kit_rows.money(_first(tags, "product:price:amount", "og:price:amount", "price"),
                             _first(tags, "product:price:currency", "og:price:currency", "priceCurrency") or currency),
        image_url=markup.absolute(url, _first(tags, "og:image:secure_url", "og:image", "twitter:image")),
        category_path=None,
        available=None if available is None else available.lower().replace(" ", "") in ("instock", "in_stock", "available"),
        fields=fields)


def check_detail(response, item):
    url = markup.page_url(response["body"])
    if url is None or markup.path_of(url) != item["id"].rstrip("/"):
        raise ValueError(f"detail is not product page {item['id']}")
    if not _first(markup.meta(response["body"]), "og:title"):
        raise ValueError(f"product page {item['id']} has no og:title")


def bind(origin, sitemap, product_path, currency=None):
    from . import page as generic_page

    def seeds():
        return [{"url": origin + sitemap}]

    def discover(response, request):
        return markup.sitemap_discover(origin, product_path, response)

    def listings(capture):
        return [{**to_row(d["body"], origin + quote(d["item_id"]), currency), "native_id": d["item_id"]}
                for d in capture["details"]]

    def page(response):
        return generic_page.read(response, currency)

    return seeds, discover, check_detail, listings, page
