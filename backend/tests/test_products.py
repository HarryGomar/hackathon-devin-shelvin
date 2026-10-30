"""Product identity: GTIN normalization, name keys and the choice of a canonical id (server/products.py)."""
import pytest

from server.products import (choose, code_of, line_key, merge_identity, name_key, normalize_gtin, product_id_for,
                             same_name)

CHOKLAD_PHOTO = {"id": "choklad-not-100-g", "brand": "IKEA", "productName": "CHOKLAD NÖT", "size": "100 g"}
CHOKLAD_BARCODE = {"id": "ikea-choklad-not-100-g", "brand": "IKEA", "productName": "IKEA CHOKLAD NÖT", "size": "100 g",
                   "barcode": "7315122013887"}
CANON = "gtin-07315122013887"


@pytest.mark.parametrize("code, gtin", [
    ("7315122013887", "07315122013887"),          # EAN-13: one leading zero
    ("07315122013887", "07315122013887"),         # already GTIN-14
    ("007315122013887", "07315122013887"),        # extra leading zeros
    (" 7315122-013887 ", "07315122013887"),       # digits only
    ("036000291452", "00036000291452"),           # UPC-A: two leading zeros
    ("12345670", "00000012345670"),               # EAN-8: six
    ("7315122013886", None),                      # wrong check digit
    ("0750103042453", None),
    ("12345", None), ("", None), (None, None), ("00000000", None),
    ("1007315122013887", None),                   # longer than 14 and not by zeros
])
def test_normalize_gtin(code, gtin):
    assert normalize_gtin(code) == gtin


def test_product_id_for():
    assert product_id_for({"barcode": "7315122013887"}) == CANON
    assert product_id_for({"barcode": "007315122013887"}) == CANON
    assert product_id_for({"barcode": "7315122013886"}) is None   # invalid: the caller keeps its own id
    assert product_id_for({"productName": "Agua"}) is None


def test_invalid_codes_compare_as_digits_never_as_a_valid_code():
    assert code_of({"barcode": "0750103042453"}) == code_of({"barcode": "750103042453"}) == "raw:750103042453"
    assert code_of({"barcode": "7315122013886"}) != code_of({"barcode": "7315122013887"})
    assert code_of({"id": CANON}) == "07315122013887"   # a gtin- id stands for its barcode
    assert code_of({"id": "agua-1-l"}) is None


@pytest.mark.parametrize("a, b", [
    (CHOKLAD_PHOTO, CHOKLAD_BARCODE),                                                     # brand not repeated
    ({"brand": "IKEA", "productName": "Choklad Not", "size": "100gr"}, CHOKLAD_PHOTO),     # case, accents, unit
    ({"brand": "X", "productName": "Y", "size": "100 gramos"}, {"brand": "x", "productName": "y", "size": "100g"}),
    ({"brand": "Coca-Cola", "productName": "Refresco", "size": "1 L"},
     {"brand": "Coca Cola", "productName": "Refresco 1000 ml"}),                          # size in the name, 1 l = 1000 ml
    ({"brand": "Bonafont", "productName": "Agua", "size": "1,5 lt"}, {"brand": "Bonafont", "productName": "Agua", "size": "1500ml"}),
    ({"brand": "A", "productName": "Lata 6x355 ml"}, {"brand": "A", "productName": "Lata 6 x 355ml"}),
])
def test_name_key_equal(a, b):
    assert name_key(a) == name_key(b)


def test_name_key_shape_and_differences():
    assert name_key(CHOKLAD_BARCODE) == "ikea choklad not 100g"
    assert name_key({"brand": "IKEA", "productName": "Choklad Mjölk", "size": "100 g"}) != name_key(CHOKLAD_PHOTO)
    assert name_key({"brand": "A", "productName": "Agua", "size": "1 l"}) != name_key({"brand": "B", "productName": "Agua", "size": "1 l"})
    assert name_key({"brand": "A", "productName": "Agua", "size": "500 ml"}) != name_key({"brand": "A", "productName": "Agua", "size": "1 l"})


def test_merge_identity_keeps_known_fields_and_barcode():
    old = {"id": "a", "brand": "IKEA", "productName": "Choklad", "barcode": "7315122013887", "imageUrl": "https://x/1.jpg"}
    new = {"id": "b", "brand": "IKEA", "productName": "Choklad Nöt", "barcode": "", "imageUrl": None, "size": "100 g"}
    merged = merge_identity(old, new, CANON)
    assert merged == {"id": CANON, "brand": "IKEA", "productName": "Choklad Nöt", "barcode": "7315122013887",
                      "imageUrl": "https://x/1.jpg", "size": "100 g"}
    assert merge_identity(old, {"barcode": "7315122013886"}, CANON)["barcode"] == "7315122013887"   # invalid never wins


def test_a_barcode_is_the_id_and_absorbs_the_photo_scan_of_the_same_name():
    assert choose(CHOKLAD_BARCODE, [CHOKLAD_BARCODE, CHOKLAD_PHOTO], CHOKLAD_BARCODE["id"]) == (
        CANON, ["ikea-choklad-not-100-g", "choklad-not-100-g"])
    # a new name for the same barcode: still the same product
    assert choose({"id": "otra", "productName": "Chocolate avellana", "barcode": "007315122013887"},
                  [dict(CHOKLAD_BARCODE, id=CANON)]) == (CANON, [])


def test_a_photo_scan_reuses_the_one_product_with_its_name():
    stored = [dict(CHOKLAD_BARCODE, id=CANON)]
    assert choose({"id": "ikea-choklad-not-100g", "brand": "Ikea", "productName": "Choklad Nöt", "size": "100 gr"},
                  stored) == (CANON, [])


def test_a_name_shared_by_two_barcodes_matches_neither():
    other = {"id": "gtin-00036000291452", "brand": "IKEA", "productName": "CHOKLAD NÖT", "size": "100 g",
             "barcode": "036000291452"}
    stored = [dict(CHOKLAD_BARCODE, id=CANON), other, CHOKLAD_PHOTO]
    assert choose({"id": "new-photo", **{k: CHOKLAD_PHOTO[k] for k in ("brand", "productName", "size")}}, stored) == (
        "new-photo", [])
    assert choose(CHOKLAD_BARCODE, stored) == (CANON, [])   # and the barcode-less one is not folded in


def test_invalid_barcodes_match_only_the_same_digits():
    takis = {"id": "takis-fuego-56-g", "brand": "Takis", "productName": "Takis Fuego", "barcode": "0750103042453"}
    assert choose({"id": "takis-fuego-56g", "brand": "Takis", "productName": "Fuego", "barcode": "750103042453"},
                  [takis]) == ("takis-fuego-56-g", [])
    assert choose({"id": "t2", "brand": "Takis", "productName": "Takis Fuego", "barcode": "0750103042454"}, [takis]) == ("t2", [])


def test_no_barcode_and_no_match_keeps_the_incoming_id_and_a_known_barcode():
    assert choose({"id": "agua-1-l", "brand": "A", "productName": "Agua"}, []) == ("agua-1-l", [])
    stored = {"id": CANON, "brand": "IKEA", "productName": "Choklad", "barcode": "7315122013887"}
    # the app edits the name of a barcoded product without sending the barcode: same product
    assert choose({"id": CANON, "brand": "IKEA", "productName": "Choklad renamed"}, [stored], CANON) == (CANON, [])
    old_slug = dict(stored, id="choklad-old")
    assert choose({"id": "choklad-old", "brand": "IKEA", "productName": "x"}, [old_slug], "choklad-old") == (
        CANON, ["choklad-old"])


def test_barcode_less_duplicates_fold_into_one():
    a = dict(CHOKLAD_PHOTO, id="a")
    b = dict(CHOKLAD_PHOTO, id="b", productName="Choklad Nöt", size="100gr")
    assert choose(dict(CHOKLAD_PHOTO, id="b"), [a, b], "b") == ("b", ["a"])
    assert choose(dict(CHOKLAD_PHOTO, id="c"), [a, b]) == ("a", ["b"])


def test_line_key_and_same_name():
    barcel = {"brand": "Barcel", "productName": "Takis Fuego", "size": "56 g"}
    takis = {"brand": "Takis", "productName": "Takis Fuego", "size": "56gr"}
    assert line_key(barcel) == line_key(takis) == "takis fuego 56g"
    assert name_key(barcel) != name_key(takis) and same_name(barcel, takis) and same_name(takis, barcel)
    lala = {"brand": "Lala", "productName": "Leche Entera", "size": "1 L"}
    alpura = {"brand": "Alpura", "productName": "Leche Entera", "size": "1000 ml"}
    assert line_key(lala) == line_key(alpura) and not same_name(lala, alpura)   # neither name carries its brand
    assert line_key({"brand": "Pinol", "productName": "Pinol", "size": "1 L"}) == ""   # one word: too generic
    assert not same_name(takis, {**takis, "size": "90 g"})


def test_a_barcode_less_photo_folds_into_the_barcoded_product_with_another_brand_field():
    stored = [{"id": "gtin-07501030424536", "brand": "Barcel", "productName": "Takis Fuego", "size": "56 g",
               "barcode": "7501030424536"}]
    photo = {"id": "takis-fuego-56g", "brand": "Takis", "productName": "Takis Fuego", "size": "56 g"}
    assert choose(photo, stored) == ("gtin-07501030424536", [])
