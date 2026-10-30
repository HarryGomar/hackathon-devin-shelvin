"""Readers that cover whole site platforms, so most sources are one `bind(...)` call.

- `shopify`: a Shopify store's `/products.json` (no detail requests; one row per variant).
- `jsonld`: a product sitemap whose pages describe a schema.org Product in JSON-LD.
- `og`: the same sitemap, for pages with only Open Graph meta tags.
- `page`: one product page by URL, JSON-LD first, then Open Graph; what `kit page` uses for any site.
"""
