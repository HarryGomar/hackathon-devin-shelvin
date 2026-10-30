"""Barcel (www.barcel.com.mx): Drupal JSON:API reader.

Built by a Claude Code run standing in for Devin, from the product name "Takis Fuego 56 g".
The site has no Shopify cart, no JSON-LD Product and no Open Graph price (it is a brand site, not a store). It runs
Drupal with the core JSON:API module open at `/jsonapi` (robots.txt allows it), which lists every "productos"
node, one per flavour across every line ("marca") Barcel sells, paged by the module's own `next` links. The run's
shared helper became `kit/generic/jsonapi.py`.
"""
from kit.generic import jsonapi

SOURCE = "barcel_mx"
ORIGIN = "https://www.barcel.com.mx"
RETAILER = "Barcel"
KIND = "first_party"
BRANDS = ("Barcel", "Takis")
INTERVAL = 2

INCLUDE = ",".join([
    "field_marca",
    "field_imagen_empaque",
    "field_imagen_producto",
    "field_imagen_main",
    "field_imagen_botana",
    "field_image_prod_dos",
    "field_imagen_producto_cuatro",
    "field_product_tres",
])

seeds, discover, check_detail, listings, page = jsonapi.bind(ORIGIN, "productos", INCLUDE)
