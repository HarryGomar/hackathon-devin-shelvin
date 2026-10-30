"""The build loop: refusals never reach a builder, the gate decides, a failed gate goes back to the same session."""
import json
import threading
import time
from pathlib import Path

from tests.conftest import PAGE, TAKIS, make_service, wait, write_source


def search(service):
    job = service.post_search({"product": TAKIS, "scanType": "both", "includeSimilar": False, "region": "MX"})[1]
    return wait(service, job["jobId"])["result"]


def test_search_marks_refused_sites_with_reason_and_alternative(tmp_path, kit_copy):
    service, _ = make_service(tmp_path, kit_copy, [])
    result = search(service)
    by_domain = {p["domain"]: p for p in result["pages"]}
    amazon = by_domain["amazon.com.mx"]
    assert amazon["access"]["status"] == "refused" and amazon["access"]["code"] == "ai_opt_out"
    assert amazon["access"]["label"] == "Blocks AI agents" and "Creators API" in amazon["access"]["alternative"]
    assert by_domain["shop.example"]["access"]["status"] == "allowed"
    assert by_domain["shop.example"]["scraper"]["status"] == "missing"
    assert result["pages"][-1]["domain"] == "amazon.com.mx"   # refused sites rank last


def test_first_attempt_fails_the_gate_and_the_same_session_fixes_it(tmp_path, kit_copy):
    def attempt_1(workspace, message):
        return write_source(workspace, written_by="DRAFT: replace spot values with ones read from the page")

    def attempt_2(workspace, message):
        assert "expected_written" in message   # the gate's report, not a paraphrase
        return {**write_source(workspace), "attempt": 2}

    service, runner = make_service(tmp_path, kit_copy, [attempt_1, attempt_2])
    result = search(service)
    shop = next(p for p in result["pages"] if p["domain"] == "shop.example")
    batch = service.post_build_batch({"pageIds": [p["id"] for p in result["pages"]]})[1]
    assert sorted(b["domain"] for b in batch["builds"]) == ["other.example", "shop.example"]   # both start at once
    assert any(s["domain"] == "amazon.com.mx" and "ClaudeBot" in s["reason"] for s in batch["skipped"])
    assert {s["domain"]: s["code"] for s in batch["skipped"]}["amazon.com.mx"] == "ai_opt_out"
    job_id = next(b["jobId"] for b in batch["builds"] if b["domain"] == "shop.example")
    view = wait(service, job_id)

    assert view["status"] == "succeeded", view.get("error")
    run = view["result"]["agentRun"]
    first, second = run["attempts"]
    assert (first["verdict"], first["sentBack"], [f["name"] for f in first["failed"]]) == ("fail", True, ["expected_written"])
    assert (second["verdict"], second["failed"]) == ("pass", [])
    assert run["state"] == "passed" and run["source"] == "shop_mx"
    sent = [m for domain, m in runner.messages if domain == "shop.example"]
    assert len(sent) == 2 and "Attempt 2 of 3" in sent[1]
    assert (Path(kit_copy) / "sources" / "shop_mx.py").is_file()   # merged into the live kit
    assert view["result"]["page"]["scraper"] == {"status": "available", "scraperId": "shop_mx"}
    assert service.store.get("pages", shop["id"])["scraper"]["status"] == "available"
    kinds = [e["kind"] for e in run["events"]]
    assert "gate" in kinds and "agent" in kinds
    record = service.get_build(job_id)[1]
    assert [g["verdict"] for g in record["gates"]] == ["fail", "pass"]   # the recording keeps both gate reports


def test_editing_outside_the_two_paths_fails_allowed_paths(tmp_path, kit_copy):
    def cheat(workspace, message):
        out = write_source(workspace)
        (Path(workspace) / "kit" / "gate.py").write_text("# the gate always passes\n", encoding="utf-8")
        return out

    service, _ = make_service(tmp_path, kit_copy, [cheat, cheat, cheat])
    job = service.builds.start(PAGE, product=TAKIS, kind="third_party")
    view = wait(service, job.id)
    run = view["agentRun"]
    assert view["status"] == "failed" and run["state"] == "needs_person"
    assert all(a["failed"][0]["name"] == "allowed_paths" for a in run["attempts"])
    assert "kit/gate.py" in run["attempts"][0]["failed"][0]["detail"]
    assert len(run["attempts"]) == 3


def test_a_refused_site_never_starts_a_session(tmp_path, kit_copy):
    service, runner = make_service(tmp_path, kit_copy, [])
    job = service.builds.start("https://www.amazon.com.mx/dp/B000", product=TAKIS)
    view = wait(service, job.id)
    assert view["status"] == "failed" and view["agentRun"]["state"] == "refused"
    assert "ClaudeBot" in view["error"] and runner.messages == []


def test_kit_gap_stops_without_retrying(tmp_path, kit_copy):
    service, runner = make_service(tmp_path, kit_copy, [
        lambda w, m: {"outcome": "kit_gap", "source": None, "notes": "needs a GraphQL reader"}])
    view = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    assert view["agentRun"]["state"] == "needs_person" and "GraphQL" in view["error"]
    assert len(runner.messages) == 1


def test_one_build_per_host_and_parallel_slots(tmp_path, kit_copy):
    live, peak, release = [0], [0], threading.Event()
    lock = threading.Lock()

    def slow(workspace, message):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        release.wait(10)
        with lock:
            live[0] -= 1
        return {"outcome": "failed", "source": None, "notes": "stopped by the test"}

    service, _ = make_service(tmp_path, kit_copy, [slow] * 3, max_parallel_builds=2, max_attempts=1)
    first = service.builds.start(PAGE, product=TAKIS)
    assert service.builds.start(PAGE, product=TAKIS) is first          # same host: the same job
    others = [service.builds.start(f"https://site{i}.example/p/1", product=TAKIS) for i in range(3)]
    service.kit.fetch_robots = lambda origin: (404, "")
    time.sleep(0.5)
    assert peak[0] <= 2
    release.set()
    for job in [first, *others]:
        wait(service, job.id)
    assert peak[0] == 2


def test_a_backend_error_ends_the_build_failed_and_says_so(tmp_path, kit_copy, capsys):
    # A failed git fetch must not leave the record at "building" with a job error of only "Server error".
    service, runner = make_service(tmp_path, kit_copy, [lambda w, m: write_source(w)])

    def gone(run, output):
        raise RuntimeError("git fetch: fatal: couldn't find remote ref refs/heads/source/shop_mx")

    runner.candidate = gone
    view = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    run = view["agentRun"]
    assert view["status"] == "failed" and run["state"] == "failed" and run["endedAt"]
    assert view["error"] == ("The backend failed during gate: RuntimeError: git fetch: fatal: couldn't find remote ref "
                             "refs/heads/source/shop_mx")
    assert run["attempts"][0]["endedAt"] and run["events"][-1]["message"] == view["error"]
    assert service.store.get("builds", run["buildId"])["state"] == "failed"   # the recording agrees
    history = service.get_builds({})[1]
    assert history["totals"]["failed"] == 1 and history["sites"][0]["lastState"] == "failed"
    logged = capsys.readouterr().out
    assert f"build.end buildId={run['buildId']} domain=shop.example provider=scripted state=failed" in logged
    assert "kind=agent" in logged and "kind=gate" not in logged   # every event is a log line; no gate ran


def test_a_site_that_blocks_the_builder_stays_refused_and_still_lists_the_product(tmp_path, kit_copy):
    # robots.txt allows shop.example, but the builder gets 403 (Soriana's Cloudflare, Bodega Aurrera's PerimeterX).
    service, runner = make_service(tmp_path, kit_copy, [
        lambda w, m: {"outcome": "blocked", "source": None, "notes": "403 to the product page"}])
    page = next(p for p in search(service)["pages"] if p["domain"] == "shop.example")
    view = wait(service, service.builds.start(PAGE, product=TAKIS, page_id=page["id"]).id)
    assert view["agentRun"]["state"] == "blocked" and len(runner.messages) == 1

    # The next search says so, and "Build all missing" skips it instead of starting another session.
    again = next(p for p in search(service)["pages"] if p["domain"] == "shop.example")
    assert again["access"]["status"] == "refused" and again["access"]["code"] == "blocked"
    assert again["access"]["label"] == "Blocks automated requests" and again["scraper"]["status"] == "missing"
    skipped = service.post_build_batch({"pageIds": [again["id"]], "productId": TAKIS["id"]})[1]["skipped"]
    assert [s["code"] for s in skipped] == ["blocked"]

    # The saved product still says it's sold there: a blocked store with no listing.
    failures = service.get_listings(TAKIS["id"])[1].get("failures", [])
    assert [(f["code"], f["retailerName"]) for f in failures if "shop.example" in f["url"]] == [("blocked", again["retailerName"])]


def test_already_exists_for_a_host_no_source_lists_ends_without_a_gate(tmp_path, kit_copy):
    # Devin found super.walmart.com.mx redirects to a host walmart_mx reads, but no source listed it: no crash on a
    # missing source/<name> branch, the build says what's wrong.
    service, _ = make_service(tmp_path, kit_copy, [
        lambda w, m: {"outcome": "already_exists", "source": "nobody_mx", "notes": "redirects to a host already read"}])
    view = wait(service, service.builds.start(PAGE, product=TAKIS).id)
    assert view["agentRun"]["state"] == "needs_person" and "no source lists that host" in view["error"]
    assert "git fetch" not in view["error"]


def test_build_history_lists_installed_sources_never_built_here(tmp_path, kit_copy):
    # chedraui_mx came in through a PR: no build here, but it collects its site.
    service, _ = make_service(tmp_path, kit_copy, [])
    sites = {s["domain"]: s for s in service.get_builds({})[1]["sites"]}
    for name, source in service.kit.sources().items():
        site = sites[source.ORIGIN.split("//")[1].removeprefix("www.")]
        assert site["source"] == name and site["installed"] is True
        assert (site["builds"], site["lastState"], site["lastBuildId"]) == (0, "exists", None)
