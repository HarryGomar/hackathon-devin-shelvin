"""One product page fetched by URL: its JSON-LD Product, else its Open Graph tags. Any site, no source file needed.

This is what the backend can use for a third-party page on a site that has no source yet, when robots allows it.
A row it cannot fill (no title and no price) is refused, so a blocked or empty page fails instead of passing.
"""
from . import jsonld, markup, og


def read(response, currency=None):
    body = response["body"]
    url = response.get("final_url") or response["url"]
    try:
        group, node = jsonld.product(body, markup.path_of(url) or "/")
        found = jsonld.to_row(group, node, url, currency)
        found["fields"]["reader"] = "jsonld"
    except ValueError:
        found = og.to_row(body, url, currency)
        found["fields"]["reader"] = "open_graph"
    if not found["title"] or (found["price"] is None and found["fields"]["reader"] == "open_graph"):
        raise ValueError(f"page has no readable product (no JSON-LD Product, no og:title and price): {url}")
    return [found]
