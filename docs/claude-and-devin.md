# Agents: Claude ⇄ Devin

The backend uses an agent in two places. Each one is a single environment variable, read when the backend starts;
the app doesn't change.

| Job | Variable | Values |
|---|---|---|
| Page search (`POST /search`) | `SEARCH` | `fixtures` (default), `claude`, `devin`, `agent` |
| Scraper build (`POST /scrapers/build`, `/scrapers/build-batch`) | `AGENT` | `devin` (the backend's default), `claude_code`, `scripted` (the default in `scripts/dev-up.sh`) |

```bash
scripts/dev-up.sh                                  # free: SEARCH=fixtures AGENT=scripted
SEARCH=claude AGENT=claude_code scripts/dev-up.sh  # all Claude
SEARCH=devin AGENT=devin scripts/dev-up.sh         # all Devin (DEVIN_API_KEY and DEVIN_ORG_ID in your shell)
SEARCH=claude AGENT=devin scripts/dev-up.sh        # mix them freely
```

`GET /health` shows which agent and search are running: `{"agent": "scripted", "search": "fixtures", "auth": true, …}`.

## Page search

Recorded searches in [`backend/fixtures/search/`](../backend/fixtures/search/) always come first, matched by barcode
(compared as GTIN-14) or by brand + name + size (`products.name_key`, so another pack size of the same product is
not replayed). Three are recorded: Takis Fuego 56 g (`7501030424536`), Takis Fuego 70 g (`7500810003671`) and Doritos
Nacho 61 g (`7501011123588`). The variable decides what happens when nothing recorded matches:

| `SEARCH=` | What runs | Needs | Cost per search |
|---|---|---|---|
| `fixtures` | Nothing. The search fails with "No pages found … (no recorded search)" | — | free |
| `claude` | One Messages API call with the server-side `web_search` tool, located in Mexico ([`server/web_search.py`](../backend/server/web_search.py), a port of the app's in-app search). Each run's raw answer, usage and cost is saved under `DATA_DIR/search_runs/` | `ANTHROPIC_API_KEY` (dev-up reads it from `app/.env`) | about US$0.20–0.50 (a Doritos Nacho search: 55k input + 2.8k output tokens on Claude Opus 5.5, 8 web searches, 43 s, US$0.36) |
| `devin` | A Devin v3 session with the same prompt and answer schema as `claude`, read from its `structured_output`, then checked by the same code (`web_search.parse_answer`) ([`server/devin_search.py`](../backend/server/devin_search.py)). Tested against a fake Devin API | `DEVIN_API_KEY`, `DEVIN_ORG_ID`; `DEVIN_SEARCH_MAX_ACU` (default 2) caps a session | at most 2 ACUs |
| `agent` | Headless Claude Code (`claude -p`) with WebSearch/WebFetch only | the `claude` CLI signed in | not measured |

A Devin search gets no list of the URLs its searches returned, so its pages are not downgraded for "not seen in
search results" the way Claude's are. Each page from any provider still gets `access` (robots.txt and the AI-agent
rule) and `scraper` from the backend.

## Scraper builds

Every builder goes through the same loop ([`backend/README.md`](../backend/README.md#a-build)): access check → probe →
attempt → the backend's own gate on a staged copy of the kit → on a failed gate the report goes back to the **same**
session, up to `MAX_ATTEMPTS` (3). The gate decides; what the builder says doesn't count. Only
`sources/<SOURCE>.py` and `fixtures/<SOURCE>/` may change.

| `AGENT=` | What runs | Needs | Cost per build |
|---|---|---|---|
| `scripted` | No agent. It replays a recorded build from [`backend/fixtures/builds/<domain>/`](../backend/fixtures/builds/) (the source, its fixtures and the builder's `report.json`) through the real gate. A domain without a recording fails at once with "no recorded build for …" | — | free |
| `claude_code` | Headless `claude -p` in a copy of the kit, with the build-source skill inlined; `--resume` on a retry. Model `CLAUDE_MODEL` (default `sonnet`), `--max-budget-usd CLAUDE_BUDGET_USD` per attempt (default 6; it applies to each of up to `MAX_ATTEMPTS` attempts) | the `claude` CLI signed in (or `ANTHROPIC_API_KEY` in its environment) | about US$1–3 |
| `devin` | A Devin v3 session in `DEVIN_REPO`: a branch `source/<SOURCE>` and a PR; the backend fetches the branch into `REPO_CLONE` and gates it. `DEVIN_MAX_ACU` (default 8) caps a session | `DEVIN_API_KEY`, `DEVIN_ORG_ID`, a clone of `DEVIN_REPO` that can fetch Devin's branches | at most `DEVIN_MAX_ACU` for the whole build: every attempt is the same session |

Devin built `officedepot_mx` this way: one session from the build request to a live scraper in 2 min 51 s, with the
backend's gate passing 26/26 on the first attempt.

Before a Devin build, run the preflight (it starts and spends nothing):

```bash
cd backend && AGENT=devin DEVIN_API_KEY=… DEVIN_ORG_ID=… uv run python -m server check
```

`DEVIN_BASE_BRANCH` (default `main`) must name a GitHub branch that has the kit. If Devin's billing refuses a session
(`billing_restricted`), the build fails with "Devin would not start a session: billing says …".

To record a build for `scripted`, run one real build and copy what passed the gate:

```bash
D=officedepot.com.mx S=officedepot_mx
mkdir -p backend/fixtures/builds/$D/sources backend/fixtures/builds/$D/fixtures
cp scraper-kit/sources/$S.py backend/fixtures/builds/$D/sources/
cp -R scraper-kit/fixtures/$S backend/fixtures/builds/$D/fixtures/
# report.json: the builder's structured output (DATA_DIR/builds/<buildId>/workspace/run-report.json for claude_code)
```

A passed build also merges into the live kit (`scraper-kit/sources/`), so the next search shows that site's pages as
`available`. The kit ships `officedepot_mx`, so the Office Depot recording only replays after
`rm scraper-kit/sources/officedepot_mx.py && rm -r scraper-kit/fixtures/officedepot_mx` and a restart; put the kit back
with `git checkout -- scraper-kit/sources scraper-kit/fixtures`.

## Safety

- Keys live only in the backend's environment. They're never written to a file, log or prompt, and `dev-up.sh` never
  prints them.
- Agent-written sources never run in the backend's process. Routing reads `SOURCE`/`ORIGIN` from the file's text, and
  the gate and the scrape run the source in child processes that get no `DEVIN_*`, `ANTHROPIC_*` or `AWS_*` variables.
- A site that refuses collection (robots.txt, the AI-agent opt-out) never starts a session.
- `.github/workflows/scraper-kit-merge.yml` (auto-merging Devin's source PRs) is disabled with `if: false`.
- With `API_TOKEN` set (dev-up always sets one), every route but `/health` needs the team token, so nobody else on the
  Wi-Fi can start a paid build.

## Who does what

| Job | Claude | Devin |
|---|---|---|
| Page search | `SEARCH=claude` | `SEARCH=devin` |
| Scraper builds | `AGENT=claude_code` | `AGENT=devin`, the main path |
| Product identification | on the phone: Open Food Facts + Claude | none: it has to answer in seconds, and a Devin session takes minutes |
