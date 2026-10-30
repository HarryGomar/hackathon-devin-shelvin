"""Patterns shared by the HTML readers."""
import html
import re
from urllib.parse import quote, unquote, urljoin, urlsplit

# A <loc> may wrap its URL in CDATA (All in One SEO writes <loc><![CDATA[https://...]]></loc>).
LOC = re.compile(r"<loc>\s*(?:<!\[CDATA\[\s*)?([^<\s\]]+)\s*(?:\]\]>)?\s*</loc>")
LD = re.compile(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", re.S | re.I)
CANONICAL = re.compile(r"<link\b[^>]*\brel=[\"']canonical[\"'][^>]*>", re.I)
OG_URL = re.compile(r"<meta\b[^>]*\bproperty=[\"']og:url[\"'][^>]*>", re.I)
HREF = re.compile(r"\b(?:href|content)=[\"']([^\"']+)[\"']")
META = re.compile(r"<meta\b([^>]*)>", re.S | re.I)
ATTR = re.compile(r"\b(property|name|content|itemprop)=[\"']([^\"']*)[\"']", re.I)
H1 = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")


def path_of(url):
    return unquote(urlsplit(url).path).rstrip("/") if isinstance(url, str) else None


def absolute(base, link):
    """A link as an absolute URL, resolved against the page it came from (Office Depot sends /medias/...)."""
    return urljoin(base, link) if isinstance(link, str) and link else link


def page_url(body):
    """The URL the page says it is: its canonical link, else its og:url."""
    for tag in (*CANONICAL.findall(body), *OG_URL.findall(body)):
        found = HREF.search(tag)
        if found:
            return html.unescape(found[1])
    return None


def meta(body):
    """Every meta tag with a property, name or itemprop and a content: tag name -> its contents, in page order."""
    tags = {}
    for attributes in META.findall(body):
        found = {k.lower(): v for k, v in ATTR.findall(attributes)}
        key = found.get("property") or found.get("name") or found.get("itemprop")
        if key and "content" in found:
            tags.setdefault(key, []).append(html.unescape(found["content"]))
    return tags


def h1(body):
    found = H1.search(body)
    return " ".join(html.unescape(TAG.sub(" ", found[1])).split()) if found else None


def sitemap_discover(origin, pattern, response):
    """Product pages of a sitemap, or the child sitemaps of a sitemap index. The item id is the decoded path."""
    body = response["body"].lstrip("﻿")
    if "<urlset" not in body and "<sitemapindex" not in body:
        raise ValueError("not a sitemap")
    locs = [html.unescape(loc) for loc in LOC.findall(body)]
    if any(urlsplit(loc).hostname != urlsplit(origin).hostname for loc in locs):
        raise ValueError("the sitemap lists a URL on another host")
    if "<sitemapindex" in body:
        return [], [{"url": loc} for loc in dict.fromkeys(locs)]
    paths = [unquote(urlsplit(loc).path) for loc in locs]
    # A child sitemap of pages or posts lists no product; that is not an error, only an empty branch.
    paths = [p for p in dict.fromkeys(paths) if re.fullmatch(pattern, p)]
    return [{"id": p, "request": {"url": origin + quote(p)}} for p in paths], []
