from kit import match
from kit.rows import row

DORITOS = {"brand": "Doritos", "productName": "Doritos Incógnita", "variant": "Incógnita", "size": "62 g",
           "barcode": "7500000000017"}


def test_barcode_is_exact_whatever_the_padding():
    assert match.score(DORITOS, row("1", "https://a.example/1", title="x", barcode="07500000000017")) == 1.0


def test_a_barcode_without_its_check_digit_still_matches():
    # Walmart México's gtin13 is the EAN with its check digit dropped, zero-padded.
    scanned = {**DORITOS, "barcode": "7501030424536"}
    assert match.score(scanned, row("1", "https://a.example/1", title="x", barcode="00750103042453")) == 1.0
    assert match.score(scanned, row("2", "https://a.example/2", title="x", barcode="00750103042454")) == 0.0
    assert not match.same_gtin("7501030424536", "7501030424")
    assert not match.same_gtin("012345678905", "123456789050")   # two valid UPC-A codes are two products


def test_words_and_size_decide_without_a_barcode():
    same = row("1", "https://a.example/1", title="Botana Doritos Incognita 62 gr", brand="Sabritas")
    bigger = row("2", "https://a.example/2", title="Doritos Incógnita 150 g")
    other = row("3", "https://a.example/3", title="Takis Fuego 56 g", brand="Barcel")
    found = match.matches(DORITOS, [other, bigger, same])
    assert [r["native_id"] for _, r in found] == ["1"]
    assert match.score(DORITOS, bigger) == 0.0


def test_size_parsing():
    assert match.size("Doritos 1.5 kg") == 1500.0
    assert match.size("62g") == 62.0
    assert match.size("sin tamaño") is None
