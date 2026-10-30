"""Builders behind one interface. The orchestrator (builds.py) never knows which one it drives.

    attempt(run, message, emit) -> {"output": <structured output or None>, "error": <str or None>}
        The first call starts a session with `message` as the prompt; each later call sends `message` (the gate's
        report) to the same session, so the builder keeps its context when it fixes its own work.
    candidate(run, output) -> (root, changed)
        The folder holding the builder's `sources/<SOURCE>.py` and `fixtures/<SOURCE>/`, and every kit-relative
        path it changed, for the backend's gate.
    stop(run)

`emit(kind, stage, message, **extra)` reports progress; extra may carry session_url, pr_url, branch, usd, acus.

- DevinRunner: the product. Devin v3 API sessions in the GitHub repo; the result is a branch and a PR.
- ClaudeCodeRunner: a local stand-in with the same skill and output schema (headless `claude -p`).
- ScriptedRunner: tests only.
- RecordedRunner (AGENT=scripted): replays a recorded build from backend/fixtures/builds/<domain>/, free and offline.
"""
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import prompts

GATE_LINE = re.compile(r"kit gate (\w+): (pass|fail|unreachable) \((\d+)/(\d+) checks passed\)")
SCHEMA_PATH = Path("devin") / "output.schema.json"


class Runner:
    provider = ""
    local = True

    def attempt(self, run, message, emit):
        raise NotImplementedError

    def candidate(self, run, output):
        raise NotImplementedError

    def stop(self, run):
        pass


# --- Devin ----------------------------------------------------------------------------------------------------
def devin_call(config, method, path, body=None):
    """One Devin v3 API call under the organization; the key comes from the environment only."""
    if not config.devin_key or not config.devin_org:
        raise RuntimeError("DEVIN_API_KEY and DEVIN_ORG_ID must be set in the backend's environment")
    url = f"{config.devin_api}/organizations/{config.devin_org}{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {config.devin_key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        whole = exc.read()
        raw = whole[:300]
        try:
            problem = json.loads(whole)
        except ValueError:
            problem = None
        problem = problem if isinstance(problem, dict) else {}
        if problem.get("error_code") == "billing_restricted":   # e.g. "... Error: out_of_quota"
            reason = str(problem.get("detail") or "").rsplit("Error:", 1)[-1].strip() or "billing"
            raise RuntimeError(f"Devin would not start a session: billing says {reason} for this organization. "
                               "Add Devin credits or upgrade the plan, then build again.") from None
        raise RuntimeError(f"Devin API {method} {path}: {exc.code} {raw!r}") from None
    return json.loads(text) if text else {}


class DevinRunner(Runner):
    """Devin v3: create a session per build, poll it, message it with the gate's report on a failed attempt.

    Field names follow docs.devin.ai/api-reference/v3 (status: new, claimed, running, exit,
    error, suspended, resuming; status_detail: working, waiting_for_user, waiting_for_approval, finished;
    pull_requests[].pr_url; acus_consumed; structured_output).
    """
    provider = "devin"
    local = False

    def __init__(self, config, kit):
        self.config, self.kit = config, kit
        self.schema = json.loads((kit.dir / SCHEMA_PATH).read_text(encoding="utf-8"))

    def _call(self, method, path, body=None):
        return devin_call(self.config, method, path, body)

    def attempt(self, run, message, emit):
        session = run.session
        if not session.get("session_id"):
            body = {"prompt": message, "repos": [self.config.devin_repo], "structured_output_schema": self.schema,
                    "structured_output_required": True, "max_acu_limit": self.config.devin_max_acu,
                    "tags": ["kit-source", run.domain, f"build:{run.id}"], "title": f"Build scraper: {run.domain}"}
            if self.config.devin_mode:
                body["devin_mode"] = self.config.devin_mode
            created = self._call("POST", "/sessions", body)
            session["session_id"] = created["session_id"]
            emit("agent", "probing", "Devin session started", session_url=created.get("url"))
        else:
            self._call("POST", f"/sessions/{session['session_id']}/messages", {"message": message})
            emit("agent", "fixing", "Sent the gate's report to the same Devin session")
        return self._wait(run, emit)

    def _wait(self, run, emit):
        deadline = time.time() + self.config.attempt_minutes * 60
        nudged, last, settled = False, {}, 0
        while time.time() < deadline:
            time.sleep(self.config.devin_poll_seconds)
            got = self._call("GET", f"/sessions/{run.session['session_id']}")
            out = got.get("structured_output") or {}
            prs = [p.get("pr_url") for p in got.get("pull_requests") or [] if p.get("pr_url")]
            state = (got.get("status"), got.get("status_detail"))
            note = out.get("progress_note") or f"Devin is {state[1] or state[0]}"
            # What the trace shows, so a status change under the same note is not the same line twice.
            seen = (out.get("stage"), note, tuple(prs))
            if seen != last.get("seen"):
                emit("agent", out.get("stage") or None, note, session_url=got.get("url"),
                     pr_url=prs[-1] if prs else None, branch=out.get("branch"), acus=got.get("acus_consumed"))
                last["seen"] = seen
            self._messages(run, emit)
            reported = out.get("outcome") not in (None, "in_progress") and (out.get("attempt") or 1) >= run.attempt
            status, detail = state
            if status in ("exit", "error"):
                return {"output": out if reported else None, "error": None if reported else f"Devin session ended ({status})"}
            if status == "suspended":
                return {"output": out if reported else None,
                        "error": None if reported else f"Devin session suspended ({detail or 'unknown'})"}
            if reported and detail in ("finished", "waiting_for_user", None):
                return {"output": out, "error": None}
            if detail == "waiting_for_user":
                if nudged:
                    return {"output": None, "error": "Devin is waiting for an answer twice; a person needs to look"}
                self._call("POST", f"/sessions/{run.session['session_id']}/messages", {"message": (
                    "Do not wait for an answer: decide under the build-source skill, run the gate, and report "
                    "your structured output with outcome set.")})
                nudged = True
                emit("system", None, "Devin asked a question; told it to decide under the skill")
            if detail == "finished" and not reported:
                settled += 1
                if settled >= 3:
                    return {"output": out or None, "error": "Devin finished without a final report"}
        return {"output": None, "error": f"no report after {self.config.attempt_minutes} minutes"}

    def _messages(self, run, emit):
        """Devin's own messages since the last poll, each as one event: what it says it is doing, in its words (its
        plan, its questions, its summary with the PR). The backend's prompts are already events of their own. A
        failed read is skipped; the next poll reads from the same cursor."""
        session = run.session
        while True:
            after = f"&after={urllib.parse.quote(session['messages_after'])}" if session.get("messages_after") else ""
            try:
                page = self._call("GET", f"/sessions/{session['session_id']}/messages?first=200{after}")
            except (RuntimeError, OSError, ValueError):
                return
            for item in page.get("items") or []:
                if item.get("source") == "devin" and item.get("event_id") not in session.setdefault("messages_seen", []):
                    session["messages_seen"].append(item.get("event_id"))
                    emit("agent", None, " ".join(str(item.get("message") or "").split())[:1000])
            if page.get("end_cursor"):
                session["messages_after"] = page["end_cursor"]
            if not page.get("has_next_page"):
                return

    def candidate(self, run, output):
        """Fetch Devin's branch into the backend's clone and extract the two paths for the gate. What it changed is
        measured from where it left the base branch, so the base's own commits never count as Devin's."""
        source, branch = output["source"], output.get("branch") or f"source/{output['source']}"
        trunk = self.config.devin_base_branch
        clone = str(self.config.repo_clone)
        def git(*args):
            done = subprocess.run(["git", "-C", clone, *args], capture_output=True)
            if done.returncode:
                raise RuntimeError(f"git {args[0]}: {done.stderr.decode('utf-8', 'replace').strip()[:300]}")
            return done.stdout
        # CI squash-merges a green source PR and deletes its branch, sometimes before this runs.
        # GitHub keeps refs/pull/<n>/head, so a PR's own ref is read whenever there is one.
        pr = re.search(rf"github\.com/{re.escape(self.config.devin_repo)}/pull/(\d+)", output.get("pr_url") or "", re.I)
        theirs = f"refs/remotes/origin/pr/{pr[1]}" if pr else f"refs/remotes/origin/{branch}"
        wanted_ref = f"refs/pull/{pr[1]}/head" if pr else f"refs/heads/{branch}"
        git("fetch", "--quiet", "origin", f"+{wanted_ref}:{theirs}", f"+refs/heads/{trunk}:refs/remotes/origin/{trunk}")
        base = git("merge-base", f"refs/remotes/origin/{trunk}", theirs).decode().strip()
        names = git("diff", "--name-only", base, theirs).decode().split()
        changed = [n.removeprefix("scraper-kit/") if n.startswith("scraper-kit/") else f"../{n}" for n in names]
        wanted = [f"scraper-kit/{p}" for p in self.kit.candidate_paths(source)
                  if f"scraper-kit/{p}" in names or any(n.startswith(f"scraper-kit/{p}/") for n in names)]
        root = run.folder / f"candidate-{run.attempt}"
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True)
        if wanted:
            archive = git("archive", "--format=tar", theirs, *wanted)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(root, filter="data")
        return root / "scraper-kit", changed

    def stop(self, run):
        if run.session.get("session_id"):
            try:
                self._call("DELETE", f"/sessions/{run.session['session_id']}")
            except RuntimeError:
                pass


# --- Claude Code (local stand-in) --------------------------------------------------------------------------
class ClaudeCodeRunner(Runner):
    provider = "claude_code"
    TOOLS = ["Bash(uv run:*)", "Bash(uv sync:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(rm capture.json)",
             "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"]

    def __init__(self, config, kit):
        self.config, self.kit = config, kit
        self.bin = shutil.which(config.claude_bin) or config.claude_bin

    def attempt(self, run, message, emit):
        workspace = Path(run.session.get("workspace") or self.kit.copy_to(run.folder / "workspace"))
        run.session["workspace"] = str(workspace)
        report = workspace / "run-report.json"
        report.unlink(missing_ok=True)
        command = [self.bin, "-p", "--model", self.config.claude_model, "--max-turns", "120", "--output-format",
                   "stream-json", "--verbose", "--max-budget-usd", self.config.claude_budget_usd,
                   "--allowedTools", *self.TOOLS]
        if run.session.get("session_id"):
            command += ["--resume", run.session["session_id"]]
        progress = workspace / "progress.jsonl"
        env = {**_clean_env(), "KIT_PROGRESS_FILE": str(progress), "PYTHONIOENCODING": "utf-8"}
        log = open(run.folder / f"agent-{run.attempt}.jsonl", "w", encoding="utf-8")
        process = subprocess.Popen(command, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, env=env, encoding="utf-8", errors="replace")
        process.stdin.write(message)
        process.stdin.close()
        timer = threading.Timer(self.config.attempt_minutes * 60, process.kill)
        timer.start()
        stop = threading.Event()
        tail = threading.Thread(target=_tail_progress, args=(progress, emit, stop), daemon=True)
        tail.start()
        gates, error = {}, None
        try:
            for line in process.stdout:
                log.write(line)
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                error = self._event(run, event, gates, emit) or error
            process.wait()
        finally:
            timer.cancel()
            stop.set()
            tail.join(timeout=3)
            log.close()
        if report.is_file():
            try:
                return {"output": json.loads(report.read_text(encoding="utf-8")), "error": None}
            except json.JSONDecodeError as exc:
                return {"output": None, "error": f"run-report.json is not JSON: {exc}"}
        return {"output": None, "error": error or f"Claude Code ended (exit {process.returncode}) without run-report.json"}

    def _event(self, run, event, gates, emit):
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            fresh = not run.session.get("session_id")
            run.session["session_id"] = event.get("session_id")
            emit("agent", "probing" if fresh else "fixing",
                 "Claude Code session started" if fresh else "Claude Code resumed the same session")
        elif kind == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("name") == "Bash":
                    command = block.get("input", {}).get("command", "")
                    if re.search(r"kit gate", command):
                        gates[block.get("id")] = command
                        emit("agent", "gate", "The agent is running the gate on its own source")
        elif kind == "user":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_result" and block.get("tool_use_id") in gates:
                    found = GATE_LINE.search(_text(block.get("content")))
                    if found:
                        source, verdict, passed, total = found.groups()
                        emit("agent_gate", "gate", f"Agent's own gate run: {verdict} ({passed}/{total} checks)",
                             gate={"source": source, "verdict": verdict, "passed": int(passed), "total": int(total)})
        elif kind == "result":
            emit("agent", None, f"Claude Code finished its turn ({event.get('num_turns')} turns)",
                 usd=event.get("total_cost_usd"))
            if event.get("is_error"):
                return f"Claude Code stopped: {event.get('subtype')}"
        return None

    def candidate(self, run, output):
        workspace = Path(run.session["workspace"])
        return workspace, self.kit.changed_paths(workspace)


def _text(content):
    if isinstance(content, str):
        return content
    return "\n".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def _tail_progress(path, emit, stop):
    """`kit progress` lines the builder writes, as they appear."""
    offset = 0
    while not stop.wait(1.0):
        if not path.is_file():
            continue
        with open(path, encoding="utf-8") as handle:
            handle.seek(offset)
            for line in handle:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                emit("agent", item.get("stage"), item.get("message", ""))
            offset = handle.tell()


def _clean_env():
    # The builder gets no Devin or cloud credentials; Claude Code keeps its own sign-in.
    return {k: v for k, v in os.environ.items() if not k.startswith(("DEVIN_", "AWS_"))}


# --- Scripted (tests) -----------------------------------------------------------------------------------------
class ScriptedRunner(Runner):
    """Attempt n runs `steps[n-1](workspace, message)`, which writes files and returns the structured output."""
    provider = "scripted"

    def __init__(self, kit, steps):
        self.kit, self.steps, self.messages = kit, steps, []

    def attempt(self, run, message, emit):
        workspace = Path(run.session.get("workspace") or self.kit.copy_to(run.folder / "workspace"))
        run.session["workspace"] = str(workspace)
        self.messages.append((run.domain, message))
        emit("agent", "writing", f"scripted attempt {run.attempt}", session_url=f"https://example.test/sessions/{run.id}")
        output = self.steps[run.attempt - 1](workspace, message)
        emit("agent", "reporting", f"reported {output.get('outcome')}")
        return {"output": output, "error": None}

    def candidate(self, run, output):
        workspace = Path(run.session["workspace"])
        return workspace, self.kit.changed_paths(workspace)


RECORDINGS = Path(__file__).resolve().parents[1] / "fixtures" / "builds"


class RecordedRunner(ScriptedRunner):
    """AGENT=scripted on a running server: no agent, no cost. A build for a domain replays what a real builder left
    for it in backend/fixtures/builds/<domain>/ (its `sources/<SOURCE>.py`, `fixtures/<SOURCE>/` and `report.json`,
    the builder's structured output). The backend's gate still judges it. A domain without a recording fails."""

    def __init__(self, config, kit, recordings=RECORDINGS, pause=None):
        super().__init__(kit, [])
        self.recordings = Path(recordings)
        self.pause = float(os.environ.get("SCRIPTED_PAUSE_SECONDS", "1.5")) if pause is None else pause

    def attempt(self, run, message, emit):
        folder = self.recordings / run.domain
        if not (folder / "report.json").is_file():
            raise RuntimeError(f"no recorded build for {run.domain} (AGENT=scripted replays backend/fixtures/builds/"
                               f"<domain>/; AGENT=claude_code or devin builds one)")
        if run.attempt > 1:
            # `message` is the gate's report; a replay would hand the gate the same files again.
            failed = "; ".join(line[2:] for line in message.splitlines() if line.startswith("- "))[:300]
            raise RuntimeError(f"the recorded build for {run.domain} failed the gate, and a replay can't fix it "
                               f"({failed or 'see the gate report'})")
        workspace = Path(run.session.get("workspace") or self.kit.copy_to(run.folder / "workspace"))
        run.session["workspace"] = str(workspace)
        report = json.loads((folder / "report.json").read_text(encoding="utf-8"))
        for stage, note in (("probing", f"Replaying the recorded build for {run.domain}"),
                            ("writing", f"Writing sources/{report['source']}.py ({report.get('reader') or 'custom'} reader)"),
                            ("capturing", "Restoring the recorded capture and expected values"),
                            ("testing", "The recorded builder's own gate run passed")):
            emit("agent", stage, note)
            time.sleep(self.pause)
        for part in ("sources", "fixtures"):
            if (folder / part).is_dir():
                shutil.copytree(folder / part, workspace / part, dirs_exist_ok=True)
        emit("agent", "reporting", f"reported {report.get('outcome')}")
        return {"output": {**report, "attempt": run.attempt}, "error": None}
