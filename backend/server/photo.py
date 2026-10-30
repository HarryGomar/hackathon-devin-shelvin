"""Product photos from Open Food Facts: the app's app/src/services/photo/ (match.ts, off-search.ts), ported as is.

Priority: the image the identity already has (the exact barcode's OFF record) → an OFF search by brand tag in Mexico,
matched locally on name, flavor and size → none. Never the user's own photo: that is a file on the phone, and only the
app may attach it. Free (no key), capped at a few seconds, never raises.
"""
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "Shelvin/1.0"
FIELDS = "code,product_name,product_name_es,brands,quantity,image_front_url"

# Words that say nothing about which product it is.
STOPWORDS = {
    "de", "del", "la", "el", "los", "las", "con", "sin", "y", "en", "a", "al", "sabor", "botana", "botanas", "the", "and",
    "with", "g", "gr", "grs", "gramos", "kg", "ml", "l", "lt", "oz", "pz", "pza", "piezas", "paquete", "bolsa", "mexico",
    "original", "unidad", "unidades", "pieza", "empaque", "tipo",
}
# Words that name a flavor or a version: one the target doesn't have means a different product.
FLAVOR_WORDS = {
    "queso", "chile", "limon", "fuego", "picante", "nacho", "salsa", "verde", "roja", "dinamita", "flamin", "flaming",
    "hot", "xtra", "extra", "habanero", "jalapeno", "chipotle", "bbq", "ranch", "crema", "cebolla", "sal", "pimienta",
    "mango", "tamarindo", "incognita", "pizzerola", "pizza", "adobado", "adobadas", "chamoy", "enchilado", "enchiladas",
    "mantequilla", "light", "zero", "fresa", "chocolate", "vainilla", "naranja", "blue", "black", "gran", "malo",
    "intense", "mix",
}
# Extra (non-flavor) words a hit may have beyond the target, for OFF's noisy names ("ADN … unidades").
MAX_EXTRA = 2


def _ascii(text):
    return unicodedata.normalize("NFD", text or "").encode("ascii", "ignore").decode()


def parse_off_search(body):
    """Search response body → hits; anything else (rate-limit page, error JSON) → []. Reads `products` and `hits`."""
    if not isinstance(body, dict):
        return []
    found = body.get("products") if isinstance(body.get("products"), list) else (
        body.get("hits") if isinstance(body.get("hits"), list) else [])
    out = []
    for p in found:
        if isinstance(p, dict):
            out.append({**p, "brands": ", ".join(p["brands"]) if isinstance(p.get("brands"), list) else p.get("brands")})
    return out


def tokens(text):
    """"Doritos® Flamin’ Hot 62 g" → ["doritos", "flamin", "hot"]."""
    t = re.sub(r"['’`´]", "", _ascii(text).lower())
    return [w for w in re.split(r"[^a-z0-9]+", t) if w and w not in STOPWORDS and not re.fullmatch(r"\d+(\.\d+)?", w)]


def _same_word(a, b):
    """Same word, allowing a plural or a cut ("nacho" / "nachos")."""
    if a == b:
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 4 and long.startswith(short) and len(long) - len(short) <= 2


def _has(words, w):
    return any(_same_word(x, w) for x in words)


def size_amount(size):
    """"61 gr" / "0.5 kg" / "600ml" → grams or millilitres; None when unreadable."""
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(kg|kilo|g|gr|grs|gramos|ml|l|lt|litro)s?\b", size or "", re.I)
    if not m:
        return None
    n = float(m.group(1).replace(",", "."))
    return n * 1000 if m.group(2).lower() in ("kg", "kilo", "l", "lt", "litro") else n


def _brand_words(target):
    makers = re.split(r"[()]", target.get("manufacturer") or "")
    return [*tokens(target.get("brand")), *[w for m in makers for w in tokens(m)]]


def score_hit(target, hit):
    """How well a hit matches (higher is better), or None when it doesn't (same rules as match.ts `scoreHit`)."""
    image = hit.get("image_front_url")
    if not isinstance(image, str) or not image.startswith("https://"):
        return None
    brand = tokens(target.get("brand"))
    makers = _brand_words(target)
    name = tokens(hit.get("product_name_es") or hit.get("product_name"))
    every = [*name, *tokens(hit.get("product_name")), *tokens(hit.get("brands"))]
    # The brand itself, not just the maker: Sabritas also makes Cheetos.
    if not brand or not all(_has(every, w) for w in brand):
        return None
    key = [w for w in dict.fromkeys([*tokens(target.get("productName")), *tokens(target.get("variant"))])
           if not _has(makers, w)]
    # Only the brand is known ("Doritos"): any Doritos photo would be a guess.
    if not key or not all(_has(every, w) for w in key):
        return None
    extras = [w for w in name if not _has(key, w) and not _has(makers, w)]
    if any(_same_word(f, w) for w in extras for f in FLAVOR_WORDS) or len(extras) > MAX_EXTRA:
        return None
    want, got = size_amount(target.get("size")), size_amount(hit.get("quantity"))
    same_size = want is not None and got is not None and abs(want - got) <= max(2, want * 0.05)
    return -len(extras) + (0.5 if same_size else 0)


def best_image(target, hits):
    """The best-matching hit's front image, or None. Ties keep OFF's order (most scanned first)."""
    best = None
    for hit in hits:
        score = score_hit(target, hit)
        if score is not None and (best is None or score > best[0]):
            best = (score, hit["image_front_url"])
    return best[1] if best else None


def search_brand_tags(target):
    """Brand tags to search, most specific first: "Doritos" / "Sabritas (PepsiCo México)" → doritos, sabritas."""
    names = [target.get("brand") or "", *re.split(r"[()]", target.get("manufacturer") or "")]
    tags = []
    for n in names:
        n = re.sub(r"\b(m[eé]xico|grupo|s\.?a\.?(\s*de\s*c\.?v\.?)?)\b", "", n, flags=re.I).strip()
        t = re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", re.sub(r"['’]", "", _ascii(n).lower())))
        if len(t) > 1 and t not in tags:
            tags.append(t)
    return tags[:2]


def _get_hits(url, timeout):
    if timeout <= 0:
        return None
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return parse_off_search(json.loads(response.read().decode("utf-8")))
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, OSError):
        return None


def search_off_image(target, timeout=3.0, get_hits=_get_hits):
    """Best Open Food Facts front image for the product: brand tag in Mexico, then full text. None after `timeout`."""
    deadline = time.monotonic() + timeout
    left = lambda: deadline - time.monotonic()
    try:
        answered = False
        for tag in search_brand_tags(target):
            hits = get_hits("https://world.openfoodfacts.org/api/v2/search?brands_tags=" + urllib.parse.quote(tag)
                            + f"&countries_tags_en=mexico&page_size=100&fields={FIELDS}", left())
            if hits is None:
                continue
            answered = True
            url = best_image(target, hits)
            if url:
                return url
        if answered:
            return None
        q = f"{target.get('productName') or ''} {target.get('variant') or ''} countries_tags:\"en:mexico\""
        hits = get_hits("https://search.openfoodfacts.org/search?q=" + urllib.parse.quote(q)
                        + f"&page_size=50&fields={FIELDS}", left())
        return best_image(target, hits) if hits else None
    except Exception:   # a photo is a nicety: never fail identification or a search over it
        return None


def with_product_photo(identity, timeout=3.0, search=search_off_image):
    """The identity with a photo: the one it has (from OFF) → an OFF search match → unchanged. Never a user photo."""
    if identity.get("imageUrl") and identity.get("imageSource") != "user_photo":
        return {**identity, "imageSource": identity.get("imageSource") or "openfoodfacts"}
    url = search(identity, timeout)
    if url:
        return {**identity, "imageUrl": url, "imageSource": "openfoodfacts"}
    return identity


def shareable(product):
    """A stored product as other phones see it: a `user_photo` is a file on the scanning phone, so it is dropped."""
    if isinstance(product, dict) and product.get("imageSource") == "user_photo":
        return {k: v for k, v in product.items() if k not in ("imageUrl", "imageSource")}
    return product
