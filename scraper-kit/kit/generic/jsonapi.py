"""Drupal sites with the core JSON:API module open: one collection of product nodes, paged by its `next` links.

Found by the second Barcel build (barcel.com.mx): a brand site with no shop, no sitemap and no JSON-LD still lists
every product node at `/jsonapi/node/<type>`. A node's own fields, its brand term and its images come in one
response through `include`, so there are no detail requests.

    from kit.generic import jsonapi
    seeds, discover, check_detail, listings, page = jsonapi.bind(ORIGIN, "productos", INCLUDE,
                                                                 brand_type="taxonomy_term--marcas")
"""
import json

from .. import rows as kit_rows


def document(response):
    """The parsed JSON:API document of a collection response, or ValueError when it is not one."""
    try:
        doc = json.loads(response["body"])
    except ValueError:
        raise ValueError(f"not JSON: {response['url']}") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
        raise ValueError(f"not a JSON:API collection: {response['url']}")
    return doc


def to_row(origin, node, included, brand_type, image_field):
    """One kit row for a node resource, given its page's `included` map (id -> resource)."""
    attrs = node["attributes"]
    nid = str(attrs["drupal_internal__nid"])
    alias = (attrs.get("path") or {}).get("alias")
    url = origin + (alias or f"/node/{nid}")
    brand, images = None, {}
    for name, rel in (node.get("relationships") or {}).items():
        data = rel.get("data")
        if not isinstance(data, dict):
            continue
        linked = included.get(data["id"])
        if linked is None:
            continue
        if linked["type"] == brand_type:
            brand = linked["attributes"].get("name")
        elif linked["type"] == "file--file":
            file_url = (linked["attributes"].get("uri") or {}).get("url")
            if file_url:
                images[name] = origin + file_url
    fields = kit_rows.flatten(attrs, skip=("title",))
    for name, file_url in images.items():
        fields[f"{name}_url"] = file_url
    return kit_rows.row(nid, url, title=attrs.get("title"), brand=brand, price=None,
                        image_url=images.get(image_field), fields=fields)


def check_detail(response, item):
    raise ValueError("a JSON:API source fetches no details")


def bind(origin, node_type, include, *, brand_type="taxonomy_term--marcas", image_field="field_imagen_empaque",
         limit=50):
    """seeds, discover, check_detail, listings and page (None: brand catalogs only) for one node collection."""

    def seeds():
        included = f"include={include}&" if include else ""
        return [{"url": f"{origin}/jsonapi/node/{node_type}?{included}page%5Blimit%5D={limit}"}]

    def discover(response, request):
        doc = document(response)
        items = [{"id": str(node["attributes"]["drupal_internal__nid"]), "request": None} for node in doc["data"]]
        next_url = ((doc.get("links") or {}).get("next") or {}).get("href")
        return items, ([{"url": next_url}] if next_url else [])

    def listings(capture):
        out = []
        for response in capture["pages"]:
            doc = document(response)
            included = {inc["id"]: inc for inc in doc.get("included", [])}
            out += [to_row(origin, node, included, brand_type, image_field) for node in doc["data"]]
        return out

    return seeds, discover, check_detail, listings, None
