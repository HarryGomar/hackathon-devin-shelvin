"""Office Depot México (www.officedepot.com.mx): generic jsonld reader, from `kit probe https://www.officedepot.com.mx/officedepot/en/Categor%C3%ADa/Todas/Oficina/Dulces/Takis-Fuego-Barcel-56-gr/p/100275440`."""
from kit.generic import page as generic_page

SOURCE = "officedepot_mx"
ORIGIN = "https://www.officedepot.com.mx"
RETAILER = "Office Depot México"
KIND = "third_party"
BRANDS = ()
INTERVAL = 2
CURRENCY = "MXN"
SAMPLE_PAGE = "https://www.officedepot.com.mx/officedepot/en/Categor%C3%ADa/Todas/Oficina/Dulces/Takis-Fuego-Barcel-56-gr/p/100275440"


def page(response):
    return generic_page.read(response, CURRENCY)
