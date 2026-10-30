"""`uv run python -m server check`: is everything ready for a real Devin build? No session is started and nothing is
spent. It asks Devin who the key belongs to (`GET /v3/self`) and whether it can open the repo, and checks that the repo's base branch on GitHub holds
what a session needs and that the output schema is one Devin accepts. The key itself is never printed."""
import json
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

# What a session reads from the base branch: the skill, the kit, its output schema and the environment file.
NEEDED = (".agents/skills/build-source/SKILL.md", "scraper-kit/kit/gate.py", "scraper-kit/devin/output.schema.json")
MAX_SCHEMA_BYTES = 64 * 1024   # the v3 API's limit on structured_output_schema


def _devin_get(config, path):
    request = urllib.request.Request(config.devin_api + path, headers={"Authorization": f"Bearer {config.devin_key}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {"detail": exc.read()[:200].decode("utf-8", "replace")}


def _key(config, call, out):
    """True when the key is accepted and belongs to DEVIN_ORG_ID."""
    key = config.devin_key
    if not key:
        out.append(("FAIL", "api key", "DEVIN_API_KEY is not set in this shell"))
        return False
    out.append(("ok", "api key", "set (a service user key)" if key.startswith("cog_") else "set (not a cog_ service user key)"))
    try:
        status, me = call(config, "/self")
    except OSError as exc:
        out.append(("FAIL", "api reachable", f"{config.devin_api}: {exc}"))
        return False
    if status != 200:
        out.append(("FAIL", "key accepted", f"GET /v3/self answered {status}: {me.get('detail', '')}"))
        return False
    org = me.get("org_id")
    out.append(("ok", "key accepted", f"{me.get('principal_type')} {me.get('service_user_name') or ''}".strip()))
    if not config.devin_org:
        out.append(("FAIL", "org id", f"DEVIN_ORG_ID is not set{f'; this key belongs to {org}' if org else ''}"))
    elif org and org != config.devin_org:
        out.append(("FAIL", "org id", f"DEVIN_ORG_ID is {config.devin_org} but this key belongs to {org}"))
    else:
        out.append(("ok", "org id", config.devin_org))
        return True
    return False


def _devin_sees_repo(config, call, out):
    # A session clones the repo through Devin's GitHub connection; without one it stops before building.
    repo = config.devin_repo
    name = urllib.parse.quote(repo.rsplit("/", 1)[-1])
    try:
        status, listed = call(config, f"/organizations/{config.devin_org}/repositories?filter_name={name}"
                                      "&load_indexing_status=false")
    except OSError as exc:
        status, listed = exc, {}
    if status != 200:
        out.append(("warn", "devin repo", f"could not list Devin's repos ({status}); check Devin can open {repo}"))
        return
    paths = [str(r.get("repo_full_name") or r.get("repo_path") or "").lower() for r in listed.get("items") or []]
    if any(p == repo.lower() or p.endswith("/" + repo.lower()) for p in paths):
        out.append(("ok", "devin repo", f"Devin's GitHub connection can open {repo}"))
    else:
        out.append(("FAIL", "devin repo", f"Devin's org sees no repo {repo}: connect GitHub in Devin's settings "
                                          "and give it access to that repo"))


def _schema(kit_dir, out):
    path = kit_dir / "devin" / "output.schema.json"
    try:
        text = path.read_text(encoding="utf-8")
        schema = json.loads(text)
    except (OSError, ValueError) as exc:
        out.append(("FAIL", "output schema", f"{path}: {exc}"))
        return
    refs = [r for r in json.dumps(schema).split('"$ref": "')[1:] if not r.startswith("#")]
    if len(text.encode()) > MAX_SCHEMA_BYTES or refs or "draft-07" not in schema.get("$schema", ""):
        out.append(("FAIL", "output schema", "must be Draft 7, self-contained and at most 64 KB"))
    else:
        out.append(("ok", "output schema", f"Draft 7, {len(text.encode())} bytes, self-contained"))


def _repo(config, out):
    if not shutil.which("git"):
        out.append(("FAIL", "git", "git is not on PATH; the backend fetches Devin's branches with it"))
        return
    clone, base = str(config.repo_clone), config.devin_base_branch
    def git(*args):
        return subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
    remote = git("remote", "get-url", "origin")
    if remote.returncode or config.devin_repo.lower() not in remote.stdout.lower():
        out.append(("FAIL", "repo clone", f"{clone}: origin is not {config.devin_repo} ({remote.stdout.strip() or remote.stderr.strip()})"))
        return
    out.append(("ok", "repo clone", f"{clone} -> {config.devin_repo}"))
    fetched = git("fetch", "--quiet", "origin", f"+refs/heads/{base}:refs/remotes/origin/{base}")
    if fetched.returncode:
        out.append(("FAIL", "base branch", f"{base} is not on GitHub: {fetched.stderr.strip()[:200]}"))
        return
    missing = [p for p in NEEDED if git("cat-file", "-e", f"refs/remotes/origin/{base}:{p}").returncode]
    if missing:
        hint = " (set DEVIN_BASE_BRANCH=scraper-kit until the kit is on main)" if base == "main" else ""
        out.append(("FAIL", "base branch", f"{base} on GitHub lacks {', '.join(missing)}{hint}"))
        return
    out.append(("ok", "base branch", f"{base} on GitHub has the skill, the kit and the schema"))
    if git("cat-file", "-e", f"refs/remotes/origin/{base}:.devin/blueprint.yaml").returncode:
        out.append(("warn", "blueprint", f"{base} has no .devin/blueprint.yaml; each session installs uv itself"))
    # The backend gates with KIT_DIR; Devin builds with the base branch on GitHub. They should be the same kit.
    kit = config.kit_dir.resolve()
    try:
        inside = kit.relative_to(config.repo_clone.resolve()).as_posix()
    except ValueError:
        out.append(("warn", "same kit", f"KIT_DIR {kit} is outside the repo clone; make sure it matches {base}"))
        return
    theirs = git("rev-parse", f"refs/remotes/origin/{base}:{inside}").stdout.strip()
    ours = git("rev-parse", f"HEAD:{inside}").stdout.strip()
    dirty = git("status", "--porcelain", "--", inside).stdout.strip()
    if theirs != ours or dirty:
        out.append(("warn", "same kit", f"the kit here differs from {base} on GitHub; commit and push it before testing"))
    else:
        out.append(("ok", "same kit", f"the backend's kit is {base} on GitHub"))


def check(config, call=_devin_get):
    """[(status, name, detail)] with status ok, warn or FAIL."""
    out = []
    if config.agent != "devin":
        out.append(("warn", "agent", f"AGENT is {config.agent}; set AGENT=devin to build with Devin"))
    if _key(config, call, out):
        _devin_sees_repo(config, call, out)
    _schema(config.kit_dir, out)
    _repo(config, out)
    out.append(("ok", "limits", f"{config.devin_max_acu} ACU per session, {config.max_parallel_builds} builds at once, "
                                f"{config.max_attempts} attempts"))
    return out


def main(config):
    results = check(config)
    for status, name, detail in results:
        print(f"{status:>4}  {name:<14} {detail}")
    failed = sum(status == "FAIL" for status, _, _ in results)
    print("ready for a Devin build" if not failed else f"{failed} check(s) failed")
    return 1 if failed else 0
