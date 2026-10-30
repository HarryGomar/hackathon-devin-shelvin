"""Scraper builds: the backend is the manager, the builder (Devin) is a worker, the gate is the judge.

One build per host at a time (Devin v3 has no idempotency key), at most MAX_PARALLEL_BUILDS sessions at once, and
per build:

    access   robots.txt and the AI-agent opt-out: a refusal ends the build before any session starts
    exists   a source already collects the host: nothing to build
    probe    the backend runs `kit probe` and hands the report to the builder
    attempt  the builder works; its progress lines reach the app as they happen
    gate     the backend runs `kit gate --live` on the builder's two paths in a staged copy of the trusted kit,
             plus `allowed_paths` (nothing else changed). Code decides; what the builder says does not count.
    fail     the gate's report goes back to the same session, up to MAX_ATTEMPTS, then a person
    pass     the two paths are merged into the live kit (Devin's PR also merges through CI)

`unreachable` from the gate is the network, not the code: it is retried once and never sent to the builder.

Every event is recorded as it happens: in the JSON store, in Postgres when DATABASE_URL is set (the build, its
attempts with the gate's report on each, every event), and as one log line. The app's build history reads that.
"""
import re
import threading
import time

from . import prompts
from .db import gate_record
from .jobs import JobFailed, now
from .kit import domain_of, summary
from .log import log

STEPS = ["probe", "build", "gate", "merge"]
STEP_OF_STAGE = {"queued": "probe", "probing": "probe", "writing": "build", "capturing": "build", "testing": "build",
                 "fixing": "build", "reporting": "build", "gate": "build", "merging": "merge"}
SOURCE_NAME = re.compile(r"^[a-z][a-z0-9_]*$")
ACTIVE = {"queued", "running", "building", "fixing"}
FAILED = {"failed", "needs_person", "blocked", "unreachable"}


def history(runs):
    """The per-site tally and the totals of builds given newest first (AgentRun views): GET /builds."""
    sites = {}
    for r in runs:
        site = sites.setdefault(r["domain"], {"domain": r["domain"], "builds": 0, "passed": 0, "failed": 0,
                                              "refused": 0, "lastState": r["state"], "lastBuildId": r["buildId"],
                                              "lastAt": r["startedAt"], "source": None})
        site["builds"] += 1
        site["passed"] += r["state"] == "passed"
        site["failed"] += r["state"] in FAILED
        site["refused"] += r["state"] == "refused"
        if site["source"] is None and r["state"] in ("passed", "exists"):
            site["source"] = r.get("source")
    totals = {"builds": len(runs), "passed": sum(r["state"] == "passed" for r in runs),
              "failed": sum(r["state"] in FAILED for r in runs), "refused": sum(r["state"] == "refused" for r in runs),
              "running": sum(r["state"] in ACTIVE for r in runs)}
    return list(sites.values()), totals


def installed_sites(sites, sources):
    """`sites` plus every source in the kit: a scraper built on another backend (or merged from a PR) has no build
    here, but it collects its site, so the Builds screen lists it as installed (`lastState` exists, no build to open)."""
    by_domain = {s["domain"]: s for s in sites}
    extra = []
    for name, source in sorted(sources.items()):
        domain = domain_of(source.ORIGIN)
        site = by_domain.get(domain)
        if site is not None:
            site.update(source=name, installed=True)
            continue
        extra.append({"domain": domain, "builds": 0, "passed": 0, "failed": 0, "refused": 0, "lastState": "exists",
                      "lastBuildId": None, "lastAt": None, "source": name, "installed": True})
    return sites + extra


class Run:
    """One build's record: what the app shows and what is saved as the run's recording."""

    def __init__(self, build_id, url, kind, product, provider, max_attempts, folder, page_id=None, user_added=False):
        self.id, self.url, self.domain, self.kind, self.product = build_id, url, domain_of(url), kind, product or {}
        self.provider, self.max_attempts, self.folder = provider, max_attempts, folder
        self.page_id, self.user_added = page_id, user_added
        self.state, self.stage, self.note = "queued", "queued", "Waiting for a free build slot"
        self.session, self.session_url, self.pr_url, self.branch, self.source = {}, None, None, None, None
        self.access, self.attempt, self.attempts, self.events, self.cost = None, 0, [], [], {}
        self.usd_before = 0.0   # cost of the attempts before this one (Claude Code reports each turn's own)
        self.started_at, self.ended_at, self.clock = now(), None, time.time()
        self.gates = {}          # attempt number -> the gate's report on it, as the database keeps it
        self.recorded = 0        # events already written to the database
        self.record_lock = threading.Lock()

    def view(self, events=40):
        return {"buildId": self.id, "provider": self.provider, "url": self.url, "domain": self.domain,
                "kind": self.kind, "state": self.state, "stage": self.stage, "note": self.note,
                "source": self.source, "sessionUrl": self.session_url, "prUrl": self.pr_url, "branch": self.branch,
                "access": self.access, "attempt": self.attempt, "maxAttempts": self.max_attempts,
                "attempts": self.attempts, "events": self.events[-events:] if events else self.events,
                "cost": self.cost, "startedAt": self.started_at, "endedAt": self.ended_at,
                "productId": self.product.get("id"), "pageId": self.page_id}


class Builds:
    def __init__(self, config, store, jobs, kit, runner, on_available=None, db=None):
        self.config, self.store, self.jobs, self.kit, self.runner = config, store, jobs, kit, runner
        self.db = db
        self.on_available = on_available or (lambda run: None)
        self.slots = threading.BoundedSemaphore(config.max_parallel_builds)
        self.lock = threading.Lock()
        self.active = {}           # domain -> job
        self.running = 0
        self.unreachable_wait = 20
        self.live_gate = True       # tests run the offline gate only

    def start(self, url, *, product=None, kind="third_party", page_id=None, user_added=False):
        """A build job for `url`'s host, or the one already running for it."""
        domain = domain_of(url)
        with self.lock:
            job = self.active.get(domain)
            if job is not None and job.status in ("queued", "running"):
                return job
            job = self.jobs.create("build", STEPS)
            run = Run(job.id, url, kind, product, self.runner.provider, self.config.max_attempts,
                      self.config.data_dir / "builds" / job.id, page_id, user_added)
            run.folder.mkdir(parents=True, exist_ok=True)
            job.detail["agentRun"] = run.view()
            job.run_record = run
            self.active[domain] = job
        return self.jobs.run(job, lambda j: self._build(j, run))

    def runs(self):
        return [job.run_record.view(events=5) for job in self.jobs.items.values() if hasattr(job, "run_record")]

    # --- one build -------------------------------------------------------------------------------------------
    def _emit(self, job, run, kind, stage, message, step=None, **extra):
        event = {"at": now(), "kind": kind, "stage": stage or run.stage, "message": message, "attempt": run.attempt}
        if extra.get("gate"):
            event["gate"] = extra["gate"]
        run.events.append(event)
        run.stage = stage or run.stage
        run.note = message
        for key in ("session_url", "pr_url", "branch"):
            if extra.get(key):
                setattr(run, key, extra[key])
        if extra.get("usd") is not None:
            run.cost["usd"] = round(run.usd_before + extra["usd"], 4)
        if extra.get("acus") is not None:
            run.cost["acus"] = extra["acus"]
        # A builder's own lines are all part of the Build step, whatever stage it names.
        job.step(step or ("build" if kind.startswith("agent") else STEP_OF_STAGE.get(run.stage, "build")), message)
        job.detail["agentRun"] = run.view()
        log("build", buildId=run.id, domain=run.domain, attempt=run.attempt, kind=kind, stage=run.stage,
            message=message[:300], acus=extra.get("acus"))
        self._record(run)

    def _record(self, run):
        """The build as it stands, to the JSON store and to Postgres. A database error is logged, never fatal: the
        JSON store still has the build, and the next event writes everything the database missed."""
        self.store.put("builds", run.id, run.view(events=0))
        if self.db is None:
            return
        with run.record_lock:
            events = len(run.events)
            try:
                self.db.record_build(run.view(events=0), run.events[run.recorded:events], run.recorded, run.gates)
                run.recorded = events
            except Exception as exc:
                log("build.record_failed", buildId=run.id, error=f"{type(exc).__name__}: {exc}"[:300])

    def _remember_block(self, run):
        """A site that blocked the builder (401/403/429, a bot challenge) stays refused: robots.txt still allows it, so
        later searches can't tell, and "Build all missing" would start another session against it. Its pages stay
        saved, so the product is still known to be sold there; they just can't be collected."""
        access = {"status": "refused", "code": "blocked",
                  "reason": f"{run.domain} blocks automated requests (401/403/429 or a bot challenge)"}
        self.store.put("blocked_sites", run.domain, {**access, "buildId": run.id, "at": run.ended_at})
        for page in self.store.all("pages"):
            if page.get("domain") == run.domain:
                self.store.put("pages", page["id"], {**page, "access": access, "scraper": {"status": "missing"}})
        if self.db is not None:
            try:
                self.db.refuse_site(run.domain, access)
            except Exception as exc:
                log("build.refuse_failed", buildId=run.id, error=f"{type(exc).__name__}: {exc}"[:300])

    def _build(self, job, run):
        emit = lambda kind, stage, message, step=None, **extra: self._emit(job, run, kind, stage, message, step, **extra)
        emit("system", "queued", f"Waiting for a free build slot ({self.running} building)", step="probe")
        with self.slots:
            with self.lock:
                self.running += 1
            try:
                return self._steps(job, run, emit)
            except JobFailed:
                raise
            except Exception as exc:   # our bug, not the builder's: the record must not stay "building"
                message = f"The backend failed during {run.stage}: {type(exc).__name__}: {exc}"[:300]
                if run.attempts and not run.attempts[-1]["endedAt"]:
                    run.attempts[-1].update(endedAt=now(), notes=run.attempts[-1]["notes"] or message)
                run.state = "failed"
                emit("system", "done", message)
                raise JobFailed(message) from exc
            finally:
                with self.lock:
                    self.running -= 1
                    if self.active.get(run.domain) is job:
                        del self.active[run.domain]
                run.ended_at = now()
                job.detail["agentRun"] = run.view()
                self._record(run)
                if run.state == "blocked":
                    self._remember_block(run)
                log("build.end", buildId=run.id, domain=run.domain, provider=run.provider, state=run.state,
                    attempts=len(run.attempts), source=run.source, prUrl=run.pr_url, cost=run.cost,
                    seconds=round(time.time() - run.clock))

    def _end(self, run, emit, state, message):
        run.state = state
        emit("system", "done", message)
        raise JobFailed(message)

    def _steps(self, job, run, emit):
        run.state = "running"
        emit("system", "probing", f"Checking robots.txt on {run.domain}", step="probe")
        run.access = self.kit.access(run.url)
        if run.access["status"] != "allowed":
            self._end(run, emit, "refused", f"{run.domain} refuses automated collection: {run.access['reason']}")
        existing = self.kit.source_for(run.url)
        if existing is not None:
            return self._done(run, emit, existing.SOURCE, f"{existing.SOURCE} already collects {run.domain}", "exists")
        emit("system", "probing", "Probing the site for a reader the kit already has", step="probe")
        try:
            report = self.kit.probe(run.url)
        except Exception as exc:   # a probe failure is information for the builder, not the end of the build
            report = {"notes": [f"probe failed: {type(exc).__name__}: {exc}"[:300]]}
        emit("system", "probing", f"Probe: reader {report.get('reader') or 'none fits'}"
             + (f" on {report['platform']}" if report.get("platform") else ""), step="probe")
        skill = self.config.skill.read_text(encoding="utf-8") if self.runner.local and self.config.skill.is_file() else ""
        message = prompts.build(run, report, local=self.runner.local, skill_text=skill,
                                base_branch=self.config.devin_base_branch)

        for n in range(1, run.max_attempts + 1):
            run.attempt = n
            attempt = {"n": n, "startedAt": now(), "endedAt": None, "outcome": None, "verdict": None,
                       "passed": 0, "total": 0, "failed": [], "sentBack": False, "notes": None}
            run.attempts.append(attempt)
            run.state = "building" if n == 1 else "fixing"
            emit("system", "writing" if n == 1 else "fixing",
                 f"Attempt {n}: {self._who()} is building the scraper" if n == 1
                 else f"Attempt {n}: the gate's report went back to the same session", step="build")
            run.usd_before = run.cost.get("usd", 0.0)
            try:
                got = self.runner.attempt(run, message, emit)
            except Exception as exc:
                attempt.update(endedAt=now(), outcome="error", notes=str(exc)[:300])
                self._end(run, emit, "failed", f"The builder could not run: {exc}"[:300])
            output = got.get("output") or {}
            attempt.update(outcome=output.get("outcome") or "no_report", notes=output.get("notes") or got.get("error"))
            if output.get("source") and SOURCE_NAME.match(str(output["source"])):
                run.source = output["source"]
            run.pr_url = output.get("pr_url") or run.pr_url
            run.branch = output.get("branch") or run.branch
            outcome = attempt["outcome"]

            if outcome == "robots_refused":
                attempt["endedAt"] = now()
                self._end(run, emit, "refused", f"The builder found {run.domain} refuses: {attempt['notes']}")
            if outcome == "blocked":
                attempt["endedAt"] = now()
                self._end(run, emit, "blocked", f"{run.domain} blocked the builder (401/403/429): {attempt['notes']}")
            if outcome == "already_exists":
                found = self.kit.source_for(run.url) or (self.kit.sources(reload=True) and self.kit.source_for(run.url))
                if found is not None:
                    attempt["endedAt"] = now()
                    return self._done(run, emit, found.SOURCE, f"{found.SOURCE} already collects {run.domain}", "exists")
                # No branch to gate: the kit has no source for this host (it may need ALIASES on the one named).
                attempt["endedAt"] = now()
                self._end(run, emit, "needs_person", f"The builder says {run.source or 'an existing source'} already reads "
                          f"{run.domain}, but no source lists that host: {attempt['notes']}")
            if outcome == "kit_gap":
                attempt["endedAt"] = now()
                self._end(run, emit, "needs_person", f"The builder needs a kit change: {attempt['notes']}")

            if not run.source:
                report = {"source": None, "verdict": "fail", "checks": [{"name": "report", "passed": False, "detail":
                          got.get("error") or "the structured output names no source"}]}
            else:
                emit("system", "gate", f"Gate: the backend is checking {run.source} (attempt {n})", step="gate")
                report = self._gate(run, output)
                if report["verdict"] == "unreachable":
                    emit("system", "gate", "The site did not answer during the gate; trying once more", step="gate")
                    time.sleep(self.unreachable_wait)
                    report = self._gate(run, output)
            failed = [{"name": c["name"], "detail": c["detail"]} for c in report["checks"] if not c["passed"]]
            attempt.update(endedAt=now(), verdict=report["verdict"], passed=len(report["checks"]) - len(failed),
                           total=len(report["checks"]), failed=failed)
            self.store.put("gates", f"{run.id}-{n}", report)
            run.gates[n] = gate_record(report)
            emit("gate", "gate", f"Gate {report['verdict']}: {attempt['passed']}/{attempt['total']} checks"
                 + (f"; failed {', '.join(f['name'] for f in failed[:4])}" if failed else ""), step="gate",
                 gate={"source": run.source, "verdict": report["verdict"], "passed": attempt["passed"],
                       "total": attempt["total"]})

            if report["verdict"] == "pass":
                emit("system", "merging", f"Merging {run.source} into the kit", step="merge")
                self.kit.merge(report["staged"], run.source)
                note = f"{run.source} passed the gate on attempt {n} and is live"
                if run.pr_url:
                    note += "; its PR merges when CI passes"
                return self._done(run, emit, run.source, note)
            if report["verdict"] == "unreachable":
                self._end(run, emit, "unreachable", f"{run.domain} did not answer during the gate; try again later")
            if n == run.max_attempts:
                self._end(run, emit, "needs_person",
                          f"The gate failed {n} attempts ({', '.join(f['name'] for f in failed[:4])}); a person needs to look")
            attempt["sentBack"] = True
            message = prompts.retry(n + 1, run.max_attempts, summary(report), local=self.runner.local)
        raise AssertionError("unreachable")

    def _gate(self, run, output):
        root, changed = self.runner.candidate(run, {**output, "source": run.source})
        staged = self.kit.stage(root, run.source, run.folder / f"gate-{run.attempt}")
        product = {**{k: run.product.get(k) for k in ("brand", "productName", "variant", "size", "barcode")
                      if run.product.get(k)}, "url": run.url}
        report = self.kit.gate(staged, run.source, product=product, live=self.live_gate)
        outside = self.kit.disallowed(changed, run.source)
        report["checks"].insert(0, {"name": "allowed_paths", "passed": not outside, "detail":
                                    f"changed outside its two paths: {', '.join(outside[:6])}" if outside
                                    else f"only sources/{run.source}.py and fixtures/{run.source}/ changed"})
        if outside:
            report["verdict"] = "fail"
        report["staged"] = str(staged)
        return report

    def _done(self, run, emit, source, message, state="passed"):
        run.source, run.state = source, state
        emit("system", "done", message, step="merge")
        page = self.on_available(run)
        return {"scraperId": source, "domain": run.domain, "page": page, "agentRun": run.view()}

    def _who(self):
        return {"devin": "Devin", "claude_code": "Claude Code", "scripted": "the scripted builder"}.get(
            self.runner.provider, self.runner.provider)
