"""The row every source returns: the app's Listing (app/src/api/types.ts) before the backend adds its ids.

    native_id      str, required: the site's own id of the listed thing (variant id, product URL path)
    url            str, required: the product page
    title          str or None
    brand          str or None
    barcode        str or None: GTIN digits as the site sends them
    sku            str or None
    price          {"amount": number, "currency": "MXN"} or None
    image_url      str or None
    category_path  [str, ...] or None: the site's own breadcrumb
    available      bool or None
    fields         {name: str | number | bool | None}: everything else the site sends (the keep-all rule:
                   no field is dropped because nobody asked for it yet)

`check_rows` refuses anything else, so a broken parser fails its test instead of shipping NULLs.
"""
import json
import re
import unicodedata

KEYS = {"native_id", "url", "title", "brand", "barcode", "sku", "price", "image_url", "category_path", "available",
        "fields"}
SCALAR = (str, int, float, bool, type(None))


def row(native_id, url, **values):
    """A row with every key present; `fields` defaults to empty."""
    if unknown := set(values) - KEYS:
        raise ValueError(f"unknown row keys: {', '.join(sorted(unknown))}")
    out = {key: None for key in KEYS}
    out["fields"] = {}
    out.update(values)
    out["native_id"], out["url"] = str(native_id), url
    return out


def money(amount, currency):
    """{"amount", "currency"} from text or a number, or None when either is missing or the amount is 0."""
    if amount in (None, "") or not currency:
        return None
    value = float(str(amount).replace(",", "")) if not isinstance(amount, (int, float)) else float(amount)
    return {"amount": value, "currency": currency} if value else None


def snake(name):
    # Accents fold to their letters ("energético" -> "energetico"), so Spanish labels stay readable keys.
    name = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def flatten(value, prefix="", out=None, skip=()):
    """Scalar leaves of nested JSON as snake_case keys (`aggregateRating.ratingValue` -> `aggregate_rating_rating_value`).
    A list of scalars becomes JSON text; a list of objects is numbered."""
    out = {} if out is None else out
    if isinstance(value, dict):
        for key, item in value.items():
            if key in skip or str(key).startswith("@"):
                continue
            flatten(item, f"{prefix}_{snake(key)}" if prefix else snake(key), out)
    elif isinstance(value, list):
        if all(isinstance(v, SCALAR) for v in value):
            out[prefix] = json.dumps(value, ensure_ascii=False)
        else:
            for n, item in enumerate(value, 1):
                flatten(item, f"{prefix}_{n}", out)
    elif prefix:
        out[prefix] = value
    return out


def check_rows(rows, where="rows"):
    seen = set()
    for n, r in enumerate(rows):
        at = f"{where}[{n}]"
        if not isinstance(r, dict) or set(r) != KEYS:
            raise ValueError(f"{at}: a row has exactly the keys {sorted(KEYS)}")
        if not isinstance(r["native_id"], str) or not r["native_id"]:
            raise ValueError(f"{at}: native_id must be text")
        if r["native_id"] in seen:
            raise ValueError(f"{at}: native_id {r['native_id']!r} repeats")
        seen.add(r["native_id"])
        if not isinstance(r["url"], str) or not r["url"].startswith(("https://", "http://127.0.0.1")):
            raise ValueError(f"{at}: url must be an https URL")
        for key in ("title", "brand", "barcode", "sku", "image_url"):
            if r[key] is not None and not isinstance(r[key], str):
                raise ValueError(f"{at}: {key} must be text or None")
        price = r["price"]
        if price is not None and (set(price) != {"amount", "currency"} or type(price["amount"]) not in (int, float)
                                  or not re.fullmatch(r"[A-Z]{3}", str(price["currency"]))):
            raise ValueError(f"{at}: price must be {{amount: number, currency: ISO code}} or None")
        path = r["category_path"]
        if path is not None and (not isinstance(path, list) or any(not isinstance(p, str) for p in path)):
            raise ValueError(f"{at}: category_path must be a list of text or None")
        if r["available"] is not None and type(r["available"]) is not bool:
            raise ValueError(f"{at}: available must be True, False or None")
        if not isinstance(r["fields"], dict) or any(not isinstance(k, str) or not isinstance(v, SCALAR)
                                                    for k, v in r["fields"].items()):
            raise ValueError(f"{at}: fields values must be text, numbers, booleans or None")
    return rows
