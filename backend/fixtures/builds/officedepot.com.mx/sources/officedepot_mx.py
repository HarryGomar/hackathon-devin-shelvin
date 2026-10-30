"""Office Depot México (officedepot.com.mx): a product page's JSON-LD Product, through the kit's generic page reader.

Hand-written as the recording AGENT=scripted replays (backend/fixtures/builds/).
"""
from kit.generic import page as generic_page

SOURCE = "officedepot_mx"
ORIGIN = "https://www.officedepot.com.mx"
RETAILER = "Office Depot México"
KIND = "third_party"
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "https://www.officedepot.com.mx/officedepot/en/Categor%C3%ADa/Todas/Oficina/Dulces/Takis-Fuego-Barcel-56-gr/p/100275440"


def page(response):
    return generic_page.read(response, CURRENCY)
