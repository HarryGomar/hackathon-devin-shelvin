"""Slow work as jobs the app polls (`GET /jobs/:id`), each on its own thread."""
import itertools
import threading
import time
import traceback
from datetime import datetime, timezone

from .log import log


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class JobFailed(Exception):
    """A business failure: the job ends `failed` with this message for the user."""


class Job:
    def __init__(self, job_id, kind, steps):
        self.id, self.kind, self.steps = job_id, kind, steps
        self.status, self.result, self.error = "queued", None, None
        self.progress = {"step": steps[0], "message": "Waiting to start", "percent": 0}
        self.detail = {}          # extra fields for the app: `agentRun` for a build, `sites` for a scrape
        self.log = {}             # for the server log only: provider, Claude usage and cost, counts
        self.created_at = now()
        self.started = time.time()

    def step(self, step, message, percent=None):
        if percent is None:
            percent = round(100 * self.steps.index(step) / len(self.steps)) if step in self.steps else None
        self.progress = {"step": step, "message": message, **({"percent": percent} if percent is not None else {})}

    def view(self):
        out = {"jobId": self.id, "status": self.status, "progress": self.progress, **self.detail}
        if self.status == "succeeded":
            out["result"] = self.result
        if self.status == "failed":
            out["error"] = self.error
        return out


class Jobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        self.ids = itertools.count(1)

    def create(self, kind, steps):
        with self.lock:
            job = Job(f"{kind}_{int(time.time()):x}{next(self.ids)}", kind, steps)
            self.items[job.id] = job
        return job

    def get(self, job_id):
        return self.items.get(job_id)

    def run(self, job, work):
        """Run `work(job)` on a thread; its return value is the result."""
        def target():
            job.status = "running"
            try:
                job.result = work(job)
                job.status = "succeeded"
                job.step("done", "Done", 100)
            except JobFailed as exc:
                job.error, job.status = str(exc), "failed"
            except Exception as exc:   # anything else is our bug; say so briefly and keep the trace in the log
                traceback.print_exc()
                job.error, job.status = f"Server error: {type(exc).__name__}", "failed"
            run_record = getattr(job, "run_record", None)
            cost = getattr(run_record, "cost", None) or None
            log("job", jobId=job.id, kind=job.kind, status=job.status, ms=round(1000 * (time.time() - job.started)),
                error=(job.error or "")[:200] or None, builder=getattr(run_record, "provider", None), cost=cost,
                **job.log)
        threading.Thread(target=target, name=job.id, daemon=True).start()
        return job
