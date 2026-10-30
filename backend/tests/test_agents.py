"""The swappable agents: SEARCH=devin (against a fake Devin API) and AGENT=scripted (a recorded build, replayed)."""
import json
import shutil
from types import SimpleNamespace

import pytest

from server.devin_search import DevinSearch
from server.runners import RecordedRunner
from server.web_search import SearchError
from tests.conftest import PAGE, TAKIS, make_service, wait, write_source


def devin_config(**extra):
    return SimpleNamespace(devin_search_max_acu=2, devin_poll_seconds=0, search_timeout=5, **extra)


def test_devin_search_creates_a_session_and_reads_its_structured_output():
    calls = []
    answer = {"pages": [
        {"url": "https://www.chedraui.com.mx/botana-barcel-takis-fuego-56g-3090610/p", "title": "Takis Fuego 56g",
         "retailerName": "Chedraui", "sourceType": "third_party", "verdict": "verified", "confidence": 0.9,
         "reason": "Same name and size"},
        {"url": "https://example.org/blog/takis", "title": "A blog", "retailerName": "Blog", "sourceType": "third_party",
         "verdict": "verified", "confidence": 0.9, "reason": "not a store"}], "similarProducts": []}
    replies = iter([{"session_id": "ses_1"}, {"status": "running", "status_detail": "working"},
                    {"status": "running", "status_detail": "finished", "structured_output": answer,
                     "url": "https://app.devin.ai/sessions/ses_1", "acus_consumed": 0.6}])

    def call(method, path, body=None):
        calls.append((method, path, body))
        return next(replies)

    found = DevinSearch(devin_config(), call=call, sleep=lambda s: None)(TAKIS, {"scanType": "both"})
    method, path, body = calls[0]
    assert (method, path) == ("POST", "/sessions") and body["max_acu_limit"] == 2
    assert body["structured_output_schema"]["required"] == ["pages", "similarProducts"]
    assert "Takis Fuego" in body["prompt"]
    assert [p["domain"] for p in found["pages"]] == ["chedraui.com.mx"]   # a non-store "third party" is dropped
    assert found["run"]["acus"] == 0.6 and found["recordedBy"] == "Devin search session"


def test_devin_search_without_a_key_is_a_readable_failure():
    config = devin_config(devin_key="", devin_org="", devin_api="https://api.devin.ai/v3")
    with pytest.raises(SearchError, match="DEVIN_API_KEY"):
        DevinSearch(config, sleep=lambda s: None)(TAKIS)


def test_scripted_agent_replays_a_recorded_build_through_the_gate(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    # A recording, as a real builder would leave it: made here with the test's VTEX builder.
    scratch = tmp_path / "scratch"
    shutil.copytree(kit_copy, scratch)
    report = write_source(scratch)
    recording = tmp_path / "builds" / "shop.example"
    (recording / "sources").mkdir(parents=True)
    shutil.copy2(scratch / "sources" / "shop_mx.py", recording / "sources" / "shop_mx.py")
    shutil.copytree(scratch / "fixtures" / "shop_mx", recording / "fixtures" / "shop_mx")
    (recording / "report.json").write_text(json.dumps(report), encoding="utf-8")

    service.builds.runner = RecordedRunner(None, service.kit, recordings=tmp_path / "builds", pause=0)
    view = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    assert view["status"] == "succeeded", view.get("error")
    assert view["result"]["agentRun"]["provider"] == "scripted"
    assert view["result"]["scraperId"] == "shop_mx" and (kit_copy / "sources" / "shop_mx.py").is_file()

    other = wait(service, service.builds.start("https://other.example/p/takis", product=TAKIS).id)
    assert other["status"] == "failed" and "no recorded build for other.example" in other["error"]
    assert len(other["agentRun"]["attempts"]) == 1


def test_a_scripted_replay_that_fails_the_gate_stops_after_one_attempt(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    scratch = tmp_path / "scratch"
    shutil.copytree(kit_copy, scratch)
    report = write_source(scratch, title="Not the title on the page")   # expected_values fails in the gate
    recording = tmp_path / "builds" / "shop.example"
    (recording / "sources").mkdir(parents=True)
    shutil.copy2(scratch / "sources" / "shop_mx.py", recording / "sources" / "shop_mx.py")
    shutil.copytree(scratch / "fixtures" / "shop_mx", recording / "fixtures" / "shop_mx")
    (recording / "report.json").write_text(json.dumps(report), encoding="utf-8")
    service.builds.runner = RecordedRunner(None, service.kit, recordings=tmp_path / "builds", pause=0)

    view = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    assert view["status"] == "failed" and len(view["agentRun"]["attempts"]) == 2
    assert view["agentRun"]["attempts"][0]["verdict"] == "fail"
    assert "a replay can't fix it (expected_values" in view["error"]


def test_a_recorded_search_for_another_size_is_not_replayed(tmp_path, kit_copy):
    """The name key holds the size: a 70 g scan named like the 56 g recording gets no recorded pages (a real search
    would run), while the barcode still finds it whatever size the phone read."""
    service, _ = make_service(tmp_path, kit_copy, [])
    path = service.search.fixtures / "takis.json"
    recorded = json.loads(path.read_text(encoding="utf-8"))
    recorded["match"].update(size="56 g", names=["Takis Fuego 56 g"])
    path.write_text(json.dumps(recorded), encoding="utf-8")
    by_name = {k: v for k, v in TAKIS.items() if k != "barcode"}
    assert service.search.recorded({**by_name, "size": "70 g"}) is None
    assert service.search.recorded({**by_name, "size": "56 g"}) is not None
    assert service.search.recorded({**TAKIS, "size": "70 g"}) is not None   # the barcode is the product


def test_a_name_match_prefers_the_recording_of_the_same_size(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    path = service.search.fixtures / "takis.json"
    recorded = json.loads(path.read_text(encoding="utf-8"))
    recorded["match"].update(size="56 g", names=["Takis Fuego 56 g"])
    path.write_text(json.dumps(recorded), encoding="utf-8")
    seventy = {**recorded, "match": {"barcodes": [], "names": ["Takis Fuego 70 g"], "size": "70 g"},
               "pages": [{**recorded["pages"][2], "title": "Takis 70 g at Other"}]}
    (service.search.fixtures / "takis-70.json").write_text(json.dumps(seventy), encoding="utf-8")
    product = {k: v for k, v in TAKIS.items() if k != "barcode"}
    job = service.post_search({"product": {**product, "size": "70 g"}, "scanType": "both", "includeSimilar": False})[1]
    assert [p["title"] for p in wait(service, job["jobId"])["result"]["pages"]] == ["Takis 70 g at Other"]
