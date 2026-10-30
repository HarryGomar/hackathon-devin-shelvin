"""Chedraui (www.chedraui.com.mx): generic vtex reader, from `kit probe https://www.chedraui.com.mx/botana-takis-fuego-94g-3808318/p`."""
from kit.generic import vtex

SOURCE = "chedraui_mx"
ORIGIN = "https://www.chedraui.com.mx"
RETAILER = "Chedraui"
KIND = "third_party"
BRANDS = ()
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "https://www.chedraui.com.mx/botana-takis-fuego-94g-3808318/p"

page_request, page = vtex.bind(ORIGIN, CURRENCY)
