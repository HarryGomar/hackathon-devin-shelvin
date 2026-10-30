"""Product identity: one product, one id. Pure functions, shared by the Postgres and the JSON-store paths.

- A product with a barcode is keyed by it: `gtin-` + the GTIN-14 of the code (`product_id_for`), so 7315122013887,
  07315122013887 and 007315122013887 are one product whatever name the scan gave it.
- A product without one (a photo scan) is matched on `name_key`: brand + name + size with accents, case,
  punctuation and unit spellings ironed out ("IKEA" + "IKEA CHOKLAD NÖT" + "100 gr" = "ikea choklad not 100g").
- `choose` decides, from the stored products that could be the same one, which id an incoming identity is saved
  under, and which stored rows are the same product and fold into it.

The app computes the same `gtin-` id (docs/api-contract.md); the backend's answer is the one to keep.
"""
import re
import unicodedata

GTIN_LENGTHS = (8, 12, 13, 14)   # EAN-8, UPC-A, EAN-13, GTIN-14


def barcode_digits(code):
    """The digits of a barcode as given ('' when there are none)."""
    return re.sub(r"\D", "", str(code or ""))


def _check_digit_ok(gtin14):
    body, check = gtin14[:-1], int(gtin14[-1])
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(body))   # weights 3,1,3,... from the left
    return (10 - total % 10) % 10 == check


def normalize_gtin(code):
    """The GTIN-14 of a barcode (digits only, zero-padded), or None when it is not a valid GTIN.

    EAN-13 gets one leading 0, UPC-A two, EAN-8 six; a code longer than 14 digits only by leading zeros is trimmed.
    A wrong check digit, an unknown length or an all-zero code is None: such a code never equals a valid one.
    """
    digits = barcode_digits(code)
    if len(digits) > 14:
        digits = digits[len(digits) - 14:] if set(digits[:len(digits) - 14]) == {"0"} else ""
    if len(digits.lstrip("0")) == 0:
        return None
    if len(digits) not in GTIN_LENGTHS:
        return None
    gtin = digits.zfill(14)
    return gtin if _check_digit_ok(gtin) else None


def product_id_for(identity):
    """`gtin-<GTIN-14>` for a product with a valid barcode, else None (the caller keeps its own id)."""
    gtin = normalize_gtin((identity or {}).get("barcode"))
    return f"gtin-{gtin}" if gtin else None


def gtin_of_id(product_id):
    """The GTIN-14 inside a `gtin-` id, or None."""
    match = re.fullmatch(r"gtin-(\d{14})", product_id or "")
    return match.group(1) if match and normalize_gtin(match.group(1)) else None


# --- name key ------------------------------------------------------------------------------------------------
_UNITS = {   # spelling -> (unit, factor to it)
    **{u: ("g", 1) for u in ("g", "gr", "grs", "gramo", "gramos", "gram", "grams", "gm", "gms")},
    **{u: ("g", 1000) for u in ("kg", "kgs", "kilo", "kilos", "kilogramo", "kilogramos", "kilogram", "kilograms")},
    **{u: ("g", 0.001) for u in ("mg", "miligramo", "miligramos")},
    **{u: ("ml", 1) for u in ("ml", "mls", "mililitro", "mililitros", "milliliter", "milliliters", "cc")},
    **{u: ("ml", 10) for u in ("cl",)},
    **{u: ("ml", 1000) for u in ("l", "lt", "lts", "litro", "litros", "liter", "liters", "litre", "litres")},
    **{u: ("oz", 1) for u in ("oz", "onza", "onzas")},
    **{u: ("pz", 1) for u in ("pz", "pza", "pzas", "pieza", "piezas", "pc", "pcs")},
}
_AMOUNT = re.compile(r"(\d+(?:[.,]\d+)?)\s*(" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")\b")


def _fold(text):
    """Lowercase ASCII, no accents (NÖT -> not, Incógnita -> incognita)."""
    return unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode().lower()


def _amount(match):
    number, (unit, factor) = float(match.group(1).replace(",", ".")), _UNITS[match.group(2)]
    value = round(number * factor, 3)
    return f" {value:g}{unit} "


def _words(text):
    """Folded words, with every amount as one token in base units ("1 L" -> "1000ml", "100 gramos" -> "100g")."""
    text = re.sub(r"(\d)\s*x\s*(\d)", r"\1 x \2", _fold(text))   # "6x355 ml" = "6 x 355ml"
    return re.findall(r"[a-z0-9.]+", _AMOUNT.sub(_amount, text))


def name_key(identity):
    """brand + productName + size, normalized; brand and size are not repeated when the name already has them."""
    identity = identity or {}
    brand, name, size = _words(identity.get("brand")), _words(identity.get("productName")), _words(identity.get("size"))
    words = list(name)
    if brand and words[:len(brand)] != brand:
        words = brand + words
    if size and not _contains(words, size):
        words += size
    return " ".join(w.strip(".") for w in words if w.strip("."))


def line_key(identity):
    """productName + size, normalized, without the brand field: productName already carries the line's brand, and
    the brand field is the part that varies between scans ("Barcel" from a database record, "Takis" off the pack).
    Empty when the name has fewer than two words besides the size, too generic to match on."""
    identity = identity or {}
    words = [w.strip(".") for w in _words(identity.get("productName")) if w.strip(".")]
    size = [w.strip(".") for w in _words(identity.get("size")) if w.strip(".")]
    if len([w for w in words if not _AMOUNT_TOKEN.fullmatch(w)]) < 2:
        return ""
    if size and not _contains(words, size):
        words += size
    return " ".join(words)


_AMOUNT_TOKEN = re.compile(r"\d+(?:\.\d+)?(?:g|ml|oz|pz)")


def name_keys(identity):
    """Every name key of an identity (for finding candidate rows; `same_name` decides)."""
    return {k for k in (name_key(identity), line_key(identity)) if k}


def _names_its_brand(identity):
    """The product name itself carries the brand field ("Takis" / "Takis Fuego")."""
    brand = [w.strip(".") for w in _words((identity or {}).get("brand")) if w.strip(".")]
    name = [w.strip(".") for w in _words((identity or {}).get("productName")) if w.strip(".")]
    return bool(brand) and _contains(name, brand)


def same_name(a, b):
    """Two scans without a shared barcode name the same product: the same name key, or the same line key when at
    least one of them has its brand in the name (so "Barcel / Takis Fuego" meets "Takis / Takis Fuego", while
    "Lala / Leche Entera" and "Alpura / Leche Entera" stay apart)."""
    key = name_key(a)
    if key and key == name_key(b):
        return True
    line = line_key(a)
    return bool(line) and line == line_key(b) and (_names_its_brand(a) or _names_its_brand(b))


def _contains(words, part):
    return any(words[i:i + len(part)] == part for i in range(len(words) - len(part) + 1))


# --- merging ---------------------------------------------------------------------------------------------------
def _blank(value):
    return value is None or value == "" or value == [] or value == {}


def merge_identity(old, new, product_id):
    """The stored identity after `new` is saved over `old`: the latest non-empty fields win, a known valid barcode
    is never replaced by a missing or invalid one, and the id is the canonical one."""
    merged = dict(old or {})
    for key, value in (new or {}).items():
        if not _blank(value):
            merged[key] = value
    if normalize_gtin((old or {}).get("barcode")) and not normalize_gtin((new or {}).get("barcode")):
        merged["barcode"] = old["barcode"]
    merged["id"] = product_id
    return merged


def code_of(identity):
    """What a barcode is compared by: its GTIN-14 when valid; else `raw:<digits, leading zeros aside>` (equal only
    to the same invalid code, never to a valid one); None without a barcode. A `gtin-` id counts as its barcode."""
    identity = identity or {}
    digits = barcode_digits(identity.get("barcode"))
    if not digits:
        return gtin_of_id(identity.get("id"))
    return normalize_gtin(digits) or f"raw:{digits.lstrip('0')}"


def choose(identity, candidates, own_id=None):
    """(id to save under, ids of stored products that are this same product and fold into it).

    `candidates`: the stored identities that could match (same GTIN, same name key, the incoming id...), newest
    first. `own_id`: the stored product the incoming id already names (itself or through an alias), if any.
      - A valid barcode: `gtin-<GTIN-14>`. Stored products with the same GTIN under another id fold in, and so do
        stored products with no barcode and the same name key, unless a different barcode also has that name.
      - An invalid barcode: the stored product with the same digits (own id first, else the newest); else as below.
      - No barcode: the stored product(s) with this name key, when they do not carry two different barcodes:
        the barcoded one, else the own id, else the newest; the other barcode-less ones fold in. Else the own id.
    A barcode-less save of a stored product that has one keeps it (never drop a known barcode).
    """
    incoming = identity.get("id")
    unique = list({c["id"]: c for c in candidates}.values())
    own = next((c for c in unique if c["id"] == own_id), None)
    if not barcode_digits(identity.get("barcode")) and not gtin_of_id(incoming) and own and code_of(own):
        identity = {**identity, "barcode": own.get("barcode"), "id": own["id"]}
    mine = code_of(identity)
    same_name_rows = [c for c in unique if same_name(identity, c)]
    name_codes = {code_of(c) for c in same_name_rows} - {None}
    loose = [c["id"] for c in same_name_rows if code_of(c) is None]   # same name, no barcode
    loose_fold = loose if name_codes <= {mine} else []
    if mine and not mine.startswith("raw:"):
        target = f"gtin-{mine}"
        absorb = [c["id"] for c in unique if code_of(c) == mine] + loose_fold
    elif mine:
        hits = [c["id"] for c in unique if code_of(c) == mine]
        pool = hits or loose_fold
        target = (own_id if own_id in pool else pool[0]) if pool else (own_id or incoming)
        absorb = hits + loose_fold
    elif same_name_rows and len(name_codes) <= 1:
        coded = sorted((c["id"] for c in same_name_rows if code_of(c)), key=lambda i: not i.startswith("gtin-"))
        target = coded[0] if coded else (own_id if own_id in loose else loose[0])
        absorb = loose
    else:
        target, absorb = own_id or incoming, []
    return target, [i for i in dict.fromkeys(absorb) if i != target]


