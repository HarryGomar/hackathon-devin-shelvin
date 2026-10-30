"""server/photo.py: the app's photo/match.test.ts cases, ported (no network)."""
from server.photo import (best_image, parse_off_search, score_hit, search_brand_tags, search_off_image, shareable,
                          size_amount, tokens, with_product_photo)


def img(code):
    return f"https://images.openfoodfacts.org/images/products/{code}/front_es.1.400.jpg"


DORITOS = [
    {"code": "7501011131064", "brands": "Doritos", "product_name": "Doritos Nachos", "quantity": "146 g", "image_front_url": img("a")},
    {"code": "7501011123588", "brands": "Doritos", "product_name": "doritos nacho", "quantity": "61 gr", "image_front_url": img("b")},
    {"code": "7501011130272", "brands": "Doritos", "product_name": "Xtra Flamin’ Hot", "quantity": "61 g", "image_front_url": img("c")},
    {"code": "7500478012138", "brands": "Doritos, Sabritas", "product_name": "Doritos ADN Incognita unidades", "quantity": "245 g", "image_front_url": img("d")},
    {"code": "7500478008025", "brands": "Doritos", "product_name": "Botana Sabritas Doritos Nacho con queso sabor chile", "quantity": ""},
]


def doritos(name, variant=None, size=None):
    return {"brand": "Doritos", "productName": name, "variant": variant, "size": size,
            "manufacturer": "Sabritas (PepsiCo México)"}


def test_search_body_parsing():
    assert len(parse_off_search({"count": 2, "products": [{"code": "1"}, None, "x", {"code": "2"}]})) == 2
    assert parse_off_search("<!DOCTYPE html>") == [] and parse_off_search({"error": "x"}) == [] and parse_off_search(None) == []
    assert parse_off_search({"hits": [{"brands": ["Doritos", "Sabritas"]}]})[0]["brands"] == "Doritos, Sabritas"


def test_same_flavor_preferring_size():
    assert best_image(doritos("Doritos Nacho", "Nacho", "61 g"), DORITOS) == img("b")
    assert best_image(doritos("Doritos Nacho", "Nacho"), DORITOS) == img("a")
    assert best_image(doritos("Doritos Incógnita", "Incógnita", "62 g"), DORITOS) == img("d")
    hot = {"brands": "Doritos", "product_name": "Doritos Flamin’ Hot", "quantity": "62 g", "image_front_url": img("h")}
    assert best_image(doritos("Doritos Flamin' Hot", "Flamin' Hot", "62 g"), [*DORITOS, hot]) == img("h")


def test_fewer_extra_words_beat_size():
    hits = [{"brands": "Doritos", "product_name": "Doritos Nacho", "image_front_url": img("plain")},
            {"brands": "Doritos", "product_name": "Doritos Nacho Queso Chile", "quantity": "62 g", "image_front_url": img("queso")}]
    assert best_image(doritos("Doritos Nacho", "Nacho", "62 g"), hits) == img("plain")
    noisy = [{"brands": "Doritos", "product_name": "Doritos Nacho ADN", "image_front_url": img("noisy")},
             {"brands": "Doritos", "product_name": "Doritos Nacho", "quantity": "62 g", "image_front_url": img("sized")},
             {"brands": "Doritos", "product_name": "Doritos Nacho", "image_front_url": img("unsized")}]
    assert best_image(doritos("Doritos Nacho", "Nacho", "62 g"), noisy) == img("sized")


def test_brand_only_or_wrong_product_gets_no_photo():
    assert best_image({"brand": "Doritos", "productName": "Doritos", "manufacturer": "Sabritas (PepsiCo México)"}, DORITOS) is None
    assert best_image({"brand": "", "productName": "Nacho"}, DORITOS) is None
    assert best_image(doritos("Doritos Pizzerola", "Pizzerola"), DORITOS) is None
    assert best_image(doritos("Doritos Flamin' Hot", "Flamin' Hot", "62 g"), DORITOS) is None
    cheetos = {"brands": "Sabritas", "product_name": "cheetos nacho", "quantity": "52 g", "image_front_url": img("e")}
    assert score_hit(doritos("Doritos Nacho", "Nacho"), cheetos) is None
    assert score_hit(doritos("Doritos Nacho", "Nacho"), {**DORITOS[1], "image_front_url": "http://x/y.jpg"}) is None
    noisy = {"brands": "Doritos", "product_name": "Doritos Nacho edicion especial mundial", "image_front_url": img("n")}
    assert score_hit(doritos("Doritos Nacho", "Nacho"), noisy) is None


def test_brand_tags_tokens_and_sizes():
    takis = {"brand": "Takis", "productName": "Takis Fuego", "variant": "Fuego", "size": "70 g", "manufacturer": "Barcel (Grupo Bimbo)"}
    assert search_brand_tags(takis) == ["takis", "barcel"]
    assert search_brand_tags(doritos("Doritos Nacho")) == ["doritos", "sabritas"]
    assert search_brand_tags({"brand": "Coca-Cola", "productName": "Coca-Cola"}) == ["coca-cola"]
    assert search_brand_tags({"brand": "Nestlé", "productName": "Nescafé", "manufacturer": "Nestlé México S.A. de C.V."}) == ["nestle"]
    assert tokens("Botana Doritos® Flamin’ Hot 62 g") == ["doritos", "flamin", "hot"]
    assert (size_amount("61 gr"), size_amount("1,5 L"), size_amount("0.5 kg"), size_amount("600ml"), size_amount("6 pzas")) == (61, 1500, 500, 600, None)


def test_photo_priority_and_never_a_user_photo():
    assert with_product_photo({"imageUrl": "https://off/x.jpg"}, search=lambda *_: "nope")["imageSource"] == "openfoodfacts"
    got = with_product_photo({"imageUrl": "file:///p.jpg", "imageSource": "user_photo"}, search=lambda *_: "https://off/s.jpg")
    assert got == {"imageUrl": "https://off/s.jpg", "imageSource": "openfoodfacts"}
    assert with_product_photo({"brand": "X"}, search=lambda *_: None) == {"brand": "X"}
    assert shareable({"id": "a", "imageUrl": "file:///p.jpg", "imageSource": "user_photo"}) == {"id": "a"}


def test_off_search_falls_back_to_full_text_only_when_tags_never_answer():
    calls = []

    def fake(url, timeout):
        calls.append(url)
        return None if "brands_tags" in url else DORITOS
    assert search_off_image(doritos("Doritos Nacho", "Nacho", "61 g"), get_hits=fake) == img("b")
    assert sum("search.openfoodfacts.org" in c for c in calls) == 1
