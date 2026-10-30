"""Devin's base branch: the prompt names it, and Devin's changes are measured from it, not from main. A billing
refusal reads as one."""
import io
import json
import subprocess
import urllib.error
from types import SimpleNamespace

import pytest

from server import prompts, runners
from server.config import Config
from server.kit import Kit
from server.runners import DevinRunner
from tests.conftest import PAGE, TAKIS


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "-C", str(cwd), *args],
                   check=True, capture_output=True)


def commit(repo, files, message):
    for name, text in files.items():
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def test_the_prompt_names_the_base_branch_only_when_it_is_not_main():
    run = SimpleNamespace(url=PAGE, kind="third_party", product=TAKIS, max_attempts=3)
    off = prompts.build(run, None, local=False, base_branch="scraper-kit")
    assert "check it out first" in off and "open the PR against `scraper-kit`" in off
    assert "not main" not in prompts.build(run, None, local=False)
    probed = prompts.build(run, {"reader": "jsonld", "missing": ["barcode"], "notes": []}, local=False)
    assert '"missing": [\n  "barcode"\n ]' in probed   # the builder learns what the reader could not fill


def test_changes_are_measured_from_the_base_branch(tmp_path, kit_copy):
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    commit(origin, {"README.md": "main"}, "main")
    git(origin, "checkout", "-q", "-b", "scraper-kit")
    commit(origin, {"scraper-kit/kit/gate.py": "the kit"}, "the kit, not on main yet")
    git(origin, "checkout", "-q", "-b", "source/shop_mx")
    commit(origin, {"scraper-kit/sources/shop_mx.py": "SOURCE = 'shop_mx'\n",
                    "scraper-kit/fixtures/shop_mx/expected.json": "{}"}, "Devin's two paths")
    clone = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(origin), str(clone))
    output = {"source": "shop_mx", "branch": "source/shop_mx"}

    runner = DevinRunner(Config(repo_clone=clone, devin_base_branch="scraper-kit"), Kit(kit_copy))
    root, changed = runner.candidate(SimpleNamespace(folder=tmp_path / "run", attempt=1), output)
    assert sorted(changed) == ["fixtures/shop_mx/expected.json", "sources/shop_mx.py"]
    assert (root / "sources" / "shop_mx.py").read_text(encoding="utf-8") == "SOURCE = 'shop_mx'\n"

    # Measured from main, the base branch's own kit commit would count as Devin's and fail allowed_paths.
    on_main = DevinRunner(Config(repo_clone=clone), Kit(kit_copy))
    _, changed = on_main.candidate(SimpleNamespace(folder=tmp_path / "run-main", attempt=1), output)
    assert "kit/gate.py" in changed


def test_a_pr_ci_already_merged_and_deleted_is_still_read(tmp_path, kit_copy):
    # CI can squash-merge a PR and delete source/<S> before the backend's gate fetches it.
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init", "-q", "-b", "scraper-kit")
    commit(origin, {"scraper-kit/kit/gate.py": "the kit"}, "the kit")
    git(origin, "checkout", "-q", "-b", "source/shop_mx")
    commit(origin, {"scraper-kit/sources/shop_mx.py": "SOURCE = 'shop_mx'\n",
                    "scraper-kit/fixtures/shop_mx/expected.json": "{}"}, "Devin's two paths")
    git(origin, "update-ref", "refs/pull/1/head", "source/shop_mx")   # what GitHub keeps for every PR
    git(origin, "checkout", "-q", "scraper-kit")
    git(origin, "merge", "-q", "--squash", "source/shop_mx")
    git(origin, "commit", "-q", "-m", "Add shop_mx (#1)")
    git(origin, "branch", "-q", "-D", "source/shop_mx")
    clone = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(origin), str(clone))
    output = {"source": "shop_mx", "branch": "source/shop_mx",
              "pr_url": "https://github.com/HarryGomar/hackathon-devin-shelvin/pull/1"}

    runner = DevinRunner(Config(repo_clone=clone, devin_base_branch="scraper-kit"), Kit(kit_copy))
    root, changed = runner.candidate(SimpleNamespace(folder=tmp_path / "run", attempt=1), output)
    assert sorted(changed) == ["fixtures/shop_mx/expected.json", "sources/shop_mx.py"]
    assert (root / "sources" / "shop_mx.py").read_text(encoding="utf-8") == "SOURCE = 'shop_mx'\n"

    with pytest.raises(RuntimeError, match="git fetch: .*source/no_pr"):   # git's own words, not exit status 128
        runner.candidate(SimpleNamespace(folder=tmp_path / "run-2", attempt=1), {"source": "no_pr", "branch": "source/no_pr"})


def test_a_billing_refusal_says_what_to_do(kit_copy, monkeypatch):
    # The body Devin's API answers when the org has no quota left.
    body = json.dumps({"type": "about:blank", "title": "Forbidden", "status": 403, "error_code": "billing_restricted",
                       "detail": "Your organization has a billing error. Error: out_of_quota"}).encode()
    def refuse(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(body))
    monkeypatch.setattr(runners.urllib.request, "urlopen", refuse)
    monkeypatch.setenv("DEVIN_API_KEY", "cog_test")
    runner = DevinRunner(Config(devin_org="org-1"), Kit(kit_copy))
    with pytest.raises(RuntimeError, match="billing says out_of_quota for this organization. Add Devin credits"):
        runner._call("POST", "/sessions", {"prompt": "x"})


@pytest.mark.parametrize("body, message", [
    (b'"Bad gateway"', "Devin API POST /sessions: 403 b'\"Bad gateway\"'"),
    (json.dumps({"error_code": "billing_restricted", "detail": "x" * 300 + " Error: out_of_credits"}).encode(),
     "billing says out_of_credits for this organization"),
    (json.dumps({"error_code": "billing_restricted", "detail": None}).encode(), "billing says billing for this organization"),
])
def test_other_bodies_keep_the_plain_message_and_a_long_billing_body_is_still_read(kit_copy, monkeypatch, body, message):
    def refuse(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, io.BytesIO(body))
    monkeypatch.setattr(runners.urllib.request, "urlopen", refuse)
    monkeypatch.setenv("DEVIN_API_KEY", "cog_test")
    with pytest.raises(RuntimeError) as raised:
        DevinRunner(Config(devin_org="org-1"), Kit(kit_copy))._call("POST", "/sessions", {"prompt": "x"})
    assert message in str(raised.value)


def test_devins_own_messages_reach_the_trace_once_each(kit_copy):
    # A real session has three: the backend's prompt, Devin's plan, Devin's summary.
    states = iter([{"status": "running", "status_detail": "working", "structured_output": {"stage": "probing"}},
                   {"status": "running", "status_detail": "finished",
                    "structured_output": {"stage": "done", "outcome": "pr_opened", "attempt": 1, "source": "shop_mx"}}])
    pages = {"": {"items": [{"event_id": "e1", "source": "user", "message": "Work on branch `scraper-kit`"},
                            {"event_id": "e2", "source": "devin", "message": "Checking out  `scraper-kit`\nnow."}],
                  "end_cursor": "c2", "has_next_page": False},
             "c2": {"items": [{"event_id": "e2", "source": "devin", "message": "Checking out `scraper-kit` now."},
                              {"event_id": "e3", "source": "devin", "message": "PR #1 is merged."}],
                    "end_cursor": "c3", "has_next_page": False}}
    asked = []

    def call(method, path, body=None):
        asked.append(path)
        if "/messages" in path:
            return pages[path.partition("&after=")[2]]
        return next(states)

    runner = DevinRunner(Config(devin_poll_seconds=0), Kit(kit_copy))
    runner._call = call
    events = []
    got = runner._wait(SimpleNamespace(session={"session_id": "devin-1"}, attempt=1),
                       lambda kind, stage, message, **extra: events.append((kind, message)))
    assert got["output"]["outcome"] == "pr_opened"
    said = [m for k, m in events if k == "agent" and not m.startswith("Devin is")]
    assert said == ["Checking out `scraper-kit` now.", "PR #1 is merged."]   # Devin's words once each, not our prompt
    assert "/sessions/devin-1/messages?first=200&after=c2" in asked


def test_a_progress_note_is_traced_once_whatever_the_session_status_does(kit_copy):
    # A session can go working -> finished under one note; the trace must show it once.
    merged = {"stage": "done", "progress_note": "Gate passed 25/25, CI green, PR merged"}
    states = iter([
        {"status": "running", "status_detail": "working", "structured_output": {"stage": "capturing", "progress_note": "Capturing"}},
        {"status": "running", "status_detail": "waiting_for_approval", "structured_output": {"stage": "capturing", "progress_note": "Capturing"}},
        {"status": "running", "status_detail": "working", "structured_output": merged},
        {"status": "running", "status_detail": "finished",
         "structured_output": {**merged, "outcome": "pr_opened", "attempt": 1, "source": "shop_mx"}}])

    def call(method, path, body=None):
        return {"items": [], "has_next_page": False} if "/messages" in path else next(states)

    runner = DevinRunner(Config(devin_poll_seconds=0), Kit(kit_copy))
    runner._call = call
    events = []
    runner._wait(SimpleNamespace(session={"session_id": "devin-1"}, attempt=1),
                 lambda kind, stage, message, **extra: events.append(message))
    assert events == ["Capturing", "Gate passed 25/25, CI green, PR merged"]
