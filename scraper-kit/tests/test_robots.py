from kit import robots

TEXT = """
User-agent: *
Disallow: /checkout
Disallow: /*?q=
Allow: /checkout/help$

User-agent: ShelvinKit
Disallow: /private

Sitemap: https://shop.example/sitemap.xml
"""


def test_the_named_group_wins_over_star():
    assert robots.allows(TEXT, "https://shop.example/checkout", "shelvinkit/0.1")
    assert not robots.allows(TEXT, "https://shop.example/private/x", "shelvinkit/0.1")


def test_star_group_patterns_and_longest_match():
    assert not robots.allows(TEXT, "https://shop.example/checkout/pay", "otherbot")
    assert robots.allows(TEXT, "https://shop.example/checkout/help", "otherbot")
    assert not robots.allows(TEXT, "https://shop.example/search?q=doritos", "otherbot")
    assert robots.allows(TEXT, "https://shop.example/products/doritos", "otherbot")


def test_statuses_decide_before_rules():
    assert robots.decide(404, "", "https://shop.example/x", "bot")[0]
    # A robots.txt that can't be read sets no rules (only rules the site wrote refuse).
    assert robots.decide(403, "", "https://shop.example/x", "bot")[0]
    assert robots.decide(503, "", "https://shop.example/x", "bot")[0]
    assert not robots.decide(200, "User-agent: *\nDisallow: /\n", "https://shop.example/x", "bot")[0]
    assert robots.decide(200, "User-agent: Googlebot\nDisallow: /\n", "https://shop.example/x", "bot")[0]


def test_sitemaps_are_listed():
    assert robots.sitemaps(TEXT) == ["https://shop.example/sitemap.xml"]
