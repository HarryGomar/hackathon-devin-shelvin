"""Sites whose product pages describe a schema.org Product in JSON-LD, listed in a product sitemap.

The sitemap is discovery and every product page is a detail. A page may describe
a product family as a ProductGroup whose `hasVariant` lists each variant with its own URL; the row is then the
variant whose URL is the page, with the group's fields where the variant has none.

    from kit.generic import jsonld
    seeds, discover, check_detail, listings, page = jsonld.bind(ORIGIN, "/sitemap.xml", r"/productos/[^/]+/?", CURRENCY)
"""
import json
from urllib.parse import quote

from .. import rows as kit_rows
from . import markup


def _nodes(body):
    for block in markup.LD.findall(body):
        try:
            data = json.loads(block.strip(), strict=False)   # a raw line break inside a string, as some sites send
        except ValueError:
            continue
        nodes = data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []
        yield from (n for n in nodes if isinstance(n, dict))


def _is(node, kind):
    kinds = node.get("@type")
    return kind in (kinds if isinstance(kinds, list) else [kinds])


def products(body):
    """(group or None, product) for every JSON-LD Product on the page, ProductGroup variants included."""
    pairs = []
    for node in _nodes(body):
        if _is(node, "Product"):
            pairs.append((None, node))
        elif _is(node, "ProductGroup"):
            pairs += [(node, v) for v in node.get("hasVariant") or [] if isinstance(v, dict)]
    return pairs


def product(body, path):
    """(group, product) of the page: its one Product, or the one whose URL is the page's path."""
    pairs = products(body)
    if len(pairs) == 1 and pairs[0][0] is None:
        return pairs[0]
    found = [p for p in pairs if markup.path_of(p[1].get("url") or p[1].get("@id")) == path.rstrip("/")]
    if len(found) != 1:
        raise ValueError(f"expected one JSON-LD Product for {path}, found {len(found)} of {len(pairs)}")
    return found[0]


def _text(value):
    if isinstance(value, dict):
        value = value.get("name") or value.get("url") or value.get("contentUrl")
    if isinstance(value, list):
        value = next((_text(v) for v in value if _text(v)), None)
    return " ".join(str(value).split()) if value not in (None, "") else None


def _offer(node):
    offers = node.get("offers")
    if isinstance(offers, list):
        offers = next((o for o in offers if isinstance(o, dict)), None)
    if isinstance(offers, dict) and isinstance(offers.get("offers"), list):   # an AggregateOffer listing its offers
        offers = next((o for o in offers["offers"] if isinstance(o, dict)), offers)
    return offers if isinstance(offers, dict) else {}


def _category(value):
    if isinstance(value, list):
        return [c for c in (_text(v) for v in value) if c] or None
    text = _text(value)
    if not text:
        return None
    for separator in (" > ", ">", " / "):
        if separator in text:
            return [part.strip() for part in text.split(separator) if part.strip()]
    return [text]


def to_row(group, node, url, currency=None):
    """The kit row of one Product (or ProductGroup variant)."""
    def pick(*names):
        for source in (node, group or {}):
            for name in names:
                if _text(source.get(name)):
                    return _text(source.get(name))
        return None

    offer = _offer(node) or _offer(group or {})
    availability = offer.get("availability")
    fields = kit_rows.flatten(node)
    if group:
        kit_rows.flatten(group, "group", fields, skip={"hasVariant"})
    return kit_rows.row(
        markup.path_of(url) or url, url,
        title=pick("name"), brand=pick("brand", "manufacturer"),
        barcode=pick("gtin13", "gtin", "gtin12", "gtin14", "gtin8"), sku=pick("sku", "mpn"),
        price=kit_rows.money(offer.get("price", offer.get("lowPrice")), offer.get("priceCurrency") or currency),
        image_url=markup.absolute(url, pick("image")), category_path=_category(node.get("category") or (group or {}).get("category")),
        available=None if not isinstance(availability, str) else "InStock" in availability or "LimitedAvailability" in availability,
        fields=fields)


def check_detail(response, item):
    """The page names itself by its canonical link or og:url, or, without either, by the URL of its Product."""
    body, path = response["body"], item["id"].rstrip("/")
    url = markup.page_url(body)
    if url is not None and markup.path_of(url) != path:
        raise ValueError(f"detail is not product page {item['id']}")
    _, found = product(body, item["id"])
    if url is None and markup.path_of(found.get("url") or found.get("@id")) != path:
        raise ValueError(f"product page {item['id']} names no URL")


def bind(origin, sitemap, product_path, currency=None):
    """seeds, discover, check_detail, listings and page for a site's sitemap and product page pattern."""
    from . import page as generic_page

    def seeds():
        return [{"url": origin + sitemap}]

    def discover(response, request):
        return markup.sitemap_discover(origin, product_path, response)

    def listings(capture):
        out = []
        for detail in capture["details"]:
            group, node = product(detail["body"], detail["item_id"])
            # The row key is the item id: the decoded path.
            out.append({**to_row(group, node, origin + quote(detail["item_id"]), currency),
                         "native_id": detail["item_id"]})
        return out

    def page(response):
        return generic_page.read(response, currency)

    return seeds, discover, check_detail, listings, page
