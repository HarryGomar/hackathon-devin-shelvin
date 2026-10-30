"""A Shopify store's public catalog: `/products.json` pages, one row per variant, no detail requests.

A store is one declaration, not a scraper. `products.json` states no currency, so
the source names the store's. Pages run until one comes back shorter than the page size.

    from kit.generic import shopify
    seeds, discover, check_detail, listings, page = shopify.bind(ORIGIN, "MXN")
"""
import json

from .. import rows as kit_rows

LIMIT = 250


def _products(response):
    try:
        data = json.loads(response["body"].lstrip("﻿"))
    except ValueError as exc:
        raise ValueError("not a products.json page") from exc
    if not isinstance(data, dict) or not isinstance(data.get("products"), list):
        raise ValueError("not a products.json page")
    return data["products"]


def _url(origin, product, variant):
    base = f"{origin}/products/{product['handle']}"
    return base if len(product.get("variants") or []) <= 1 else f"{base}?variant={variant['id']}"


def to_rows(origin, product, currency):
    out = []
    images = [i for i in product.get("images") or [] if isinstance(i, dict) and i.get("src")]
    base = kit_rows.flatten(product, skip={"variants", "images", "options"})
    base["image_count"] = len(images)
    base["options"] = json.dumps([o.get("name") for o in product.get("options") or []], ensure_ascii=False)
    for variant in product.get("variants") or []:
        title = product.get("title")
        if variant.get("title") and variant["title"] != "Default Title":
            title = f"{title} - {variant['title']}"
        image = (variant.get("featured_image") or {}).get("src") or (images[0]["src"] if images else None)
        fields = {**base, **kit_rows.flatten(variant, "variant", skip={"featured_image"})}
        out.append(kit_rows.row(
            variant["id"], _url(origin, product, variant), title=title, brand=product.get("vendor") or None,
            barcode=(variant.get("barcode") or "").strip() or None, sku=(variant.get("sku") or "").strip() or None,
            price=kit_rows.money(variant.get("price"), currency), image_url=image,
            category_path=[product["product_type"]] if product.get("product_type") else None,
            available=variant.get("available") if isinstance(variant.get("available"), bool) else None,
            fields=fields))
    return out


def check_detail(response, item):
    raise ValueError("a Shopify source fetches no details")


def bind(origin, currency, collection="all", limit=LIMIT):
    from . import page as generic_page

    path = "/products.json" if collection == "all" else f"/collections/{collection}/products.json"

    def seeds():
        return [{"url": f"{origin}{path}?limit={limit}&page=1"}]

    def discover(response, request):
        products = _products(response)
        items = [{"id": str(v["id"]), "request": None} for p in products for v in p.get("variants") or []]
        if len(products) < limit:
            return items, []
        number = int(request["url"].rsplit("page=", 1)[1])
        return items, [{"url": f"{origin}{path}?limit={limit}&page={number + 1}"}]

    def listings(capture):
        return [r for response in capture["pages"] for p in _products(response) for r in to_rows(origin, p, currency)]

    def page(response):
        return generic_page.read(response, currency)

    return seeds, discover, check_detail, listings, page
