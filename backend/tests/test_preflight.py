"""`python -m server check` says whether a Devin build can start, without starting one."""
from server import preflight
from server.config import Config
from tests.conftest import REPO
from tests.test_devin_branch import commit, git

SCHEMA = (REPO / "scraper-kit" / "devin" / "output.schema.json").read_text(encoding="utf-8")
ME = {"principal_type": "service_user", "service_user_name": "shelvin-builds", "service_user_id": "su-1", "org_id": "org-1"}


def repo(tmp_path):
    origin = tmp_path / "hackathon-devin-shelvin"
    origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    commit(origin, {"README.md": "main"}, "main")
    git(origin, "checkout", "-q", "-b", "scraper-kit")
    commit(origin, {".agents/skills/build-source/SKILL.md": "skill", "scraper-kit/kit/gate.py": "gate",
                    "scraper-kit/devin/output.schema.json": SCHEMA, ".devin/blueprint.yaml": "initialize: x"}, "kit")
    clone = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(origin), str(clone))
    return clone


def statuses(results):
    return {name: status for status, name, _ in results}


def devin(repos=("HarryGomar/hackathon-devin-shelvin",), asked=None):
    """A stand-in for Devin's API: who the key is, and the repos its GitHub connection can open."""
    def call(config, path):
        if asked is not None:
            asked.append(path)
        if path == "/self":
            return 200, ME
        return 200, {"items": [{"repo_full_name": r, "repo_path": r} for r in repos], "total": len(repos)}
    return call


def test_ready_when_key_org_branch_and_schema_line_up(tmp_path, monkeypatch):
    monkeypatch.setenv("DEVIN_API_KEY", "cog_test")
    clone = repo(tmp_path)
    config = Config(agent="devin", devin_org="org-1", devin_repo="hackathon-devin-shelvin", repo_clone=clone,
                    kit_dir=clone / "scraper-kit", devin_base_branch="scraper-kit")
    asked = []
    results = preflight.check(config, call=devin(asked=asked))
    assert asked == ["/self", "/organizations/org-1/repositories?filter_name=hackathon-devin-shelvin&load_indexing_status=false"]
    assert set(statuses(results).values()) == {"ok"}, results


def test_fails_when_devin_cannot_open_the_repo(tmp_path, monkeypatch):
    # The key and credits are fine, but the org has no GitHub connection, so a session would stop.
    monkeypatch.setenv("DEVIN_API_KEY", "cog_test")
    clone = repo(tmp_path)
    config = Config(agent="devin", devin_org="org-1", devin_repo="HarryGomar/hackathon-devin-shelvin", repo_clone=clone,
                    kit_dir=clone / "scraper-kit", devin_base_branch="scraper-kit")
    for repos in ((), ("someone-else/hackathon-devin-shelvin",)):
        found = [(s, d) for s, n, d in preflight.check(config, call=devin(repos)) if n == "devin repo"]
        assert found == [("FAIL", "Devin's org sees no repo HarryGomar/hackathon-devin-shelvin: connect GitHub in "
                                  "Devin's settings and give it access to that repo")]
    unlisted = preflight.check(config, call=lambda c, path: (200, ME) if path == "/self" else (403, {"detail": "x"}))
    assert statuses(unlisted)["devin repo"] == "warn"


def test_names_what_is_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("DEVIN_API_KEY", raising=False)
    clone = repo(tmp_path)
    config = Config(agent="claude_code", devin_org="org-1", devin_repo="hackathon-devin-shelvin", repo_clone=clone,
                    kit_dir=clone / "scraper-kit")
    found = statuses(preflight.check(config, call=devin()))
    assert (found["agent"], found["api key"], found["base branch"]) == ("warn", "FAIL", "FAIL")

    monkeypatch.setenv("DEVIN_API_KEY", "cog_test")
    other_org = preflight.check(Config(agent="devin", devin_org="org-2", devin_repo="hackathon-devin-shelvin",
                                       repo_clone=clone, kit_dir=clone / "scraper-kit", devin_base_branch="scraper-kit"),
                                call=devin())
    assert [d for s, n, d in other_org if n == "org id"] == ["DEVIN_ORG_ID is org-2 but this key belongs to org-1"]
    refused = preflight.check(Config(agent="devin", devin_org="org-1", repo_clone=clone, kit_dir=clone / "scraper-kit"),
                              call=lambda c, path: (401, {"detail": "invalid token"}))
    assert statuses(refused)["key accepted"] == "FAIL"
