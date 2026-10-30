"""ALIASES: hosts that redirect to a source's ORIGIN (a "super." store on the main host) route to that source."""
import types

import pytest

from kit.source import check_source, for_url, on_origin


def source(**extra):
    return types.SimpleNamespace(SOURCE="shop_mx", ORIGIN="https://www.shop.mx", RETAILER="Shop", KIND="third_party",
                                 INTERVAL=2, SAMPLE_PAGE="https://www.shop.mx/p", page=lambda r: None, **extra)


def test_an_alias_host_routes_to_its_source_and_reads_on_its_origin():
    shop = check_source(source(ALIASES=("super.shop.mx",)))
    url = "https://super.shop.mx/ip/botana-doritos-dinamita-65-g/00750047801851"
    assert for_url({"shop_mx": shop}, url) == [shop]
    assert for_url({"shop_mx": check_source(source())}, url) == []
    assert on_origin(shop, url) == "https://www.shop.mx/ip/botana-doritos-dinamita-65-g/00750047801851"
    own = "https://www.shop.mx/ip/x/1?a=b"
    assert on_origin(shop, own) == own


def test_aliases_must_be_host_names():
    with pytest.raises(ValueError, match="ALIASES"):
        check_source(source(ALIASES=("https://super.shop.mx/",)))
