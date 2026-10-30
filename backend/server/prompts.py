"""What the builder is told: the first prompt, and the gate's report when an attempt fails."""
import json

ADAPTER_LOCAL = """You are running locally as a stand-in for Devin, already inside `scraper-kit/`. Follow the skill
below with these differences: there is no git, branch or PR; stop after step 6 and write your structured output
(the schema is in devin/output.schema.json) as JSON to `run-report.json` in this folder, with `branch` and
`pr_url` null and outcome `built_no_pr` when the gate passes. The backend then runs the same gate itself and
merges your two paths. `kit progress` writes where the backend reads it."""


def _probe_text(report):
    if not report:
        return "none"
    keep = {k: report.get(k) for k in ("access", "platform", "reader", "sitemaps", "jsonapi_node_types", "missing", "notes")}
    row = report.get("row") or {}
    if row:
        keep["row"] = {k: row.get(k) for k in ("native_id", "title", "price", "brand", "barcode", "url")}
    return json.dumps(keep, ensure_ascii=False, indent=1)[:4000]


def _base_text(base_branch):
    if base_branch == "main":
        return "Use the build-source skill (.agents/skills/build-source/SKILL.md in the repo)."
    # Before the kit is on main, the skill, the kit and the blueprint exist only on the base branch.
    return (f"Work on branch `{base_branch}`, not main: check it out first, then use the build-source skill "
            f"(.agents/skills/build-source/SKILL.md on that branch). Branch `source/<SOURCE>` off `{base_branch}` "
            f"and open the PR against `{base_branch}`. If `uv` is missing, install it with "
            f"`curl -LsSf https://astral.sh/uv/install.sh | sh`.")


def build(run, probe_report, *, local, skill_text="", base_branch="main"):
    product = {k: run.product.get(k) for k in ("brand", "productName", "variant", "size", "barcode") if run.product.get(k)}
    task = f"""## This build

- Product page: {run.url}
- Kind: {run.kind} ({"the brand's own site: cover its whole catalog" if run.kind == "first_party" else "a retailer: a page-only source"})
- Scanned product: {json.dumps(product, ensure_ascii=False)}
- Attempt: 1 of {run.max_attempts}
- Gate command: uv run python -m kit gate <SOURCE> --live --product '{json.dumps({**product, "url": run.url}, ensure_ascii=False)}'

The backend already probed the page (`kit probe`):

```json
{_probe_text(probe_report)}
```
"""
    if local:
        return f"{ADAPTER_LOCAL}\n\n{task}\n\n# The skill\n\n{skill_text}"
    return f"{_base_text(base_branch)}\n\n{task}"


def retry(attempt, max_attempts, gate_summary, *, local):
    where = "Write run-report.json again" if local else "Push to the same branch so the PR updates, and update your structured output"
    return f"""Attempt {attempt} of {max_attempts}. The backend ran the gate on your source and it failed. This report is
the code's decision, not an opinion: fix what it names, keep everything else, run the gate again until it exits 0,
then report. {where}, with `attempt` set to {attempt}. Do not ask questions; if it cannot be fixed inside your
two paths, report outcome `kit_gap` or `failed` with the reason.

```
{gate_summary}
```"""
