# Backend

The server behind the app ([API contract](../docs/api-contract.md)). Standard library plus psycopg (for the optional Postgres); Python 3.12 via uv.
It finds pages, checks each site's access policy, builds missing scrapers with Devin, lets code decide whether a
scraper passes, and runs the scrapers in [scraper-kit](../scraper-kit).

```
cd backend
uv run python -m server                       # :8791; the app's .env: EXPO_PUBLIC_API_MODE=live, EXPO_PUBLIC_API_BASE_URL=http://<lan-ip>:8791
uv run --group dev pytest -q                  # offline, a scripted builder
uv run python -m server check                 # ready for a Devin build? key, org, base branch, schema; spends nothing
```

## The API

[docs/backend-spec.md](../docs/backend-spec.md) is the contract; check a running server with
[tools/contract-check](../tools/contract-check) (`BASE_URL=... TOKEN=... npm run check -- --no-search`, then without
`--no-search` for a search, a build and two scrapes).

- **Auth.** With `API_TOKEN` set, every route but `GET /health` needs `Authorization: Bearer <API_TOKEN>` (compared
  in constant time); without it auth is off and the server says so at start. The app sends `EXPO_PUBLIC_API_TOKEN`.
- **Errors.** Every non-2xx body is `{"error": "<shown to the user>", "code": "..."}`: 400 `invalid_request` /
  `invalid_url`, 401 `unauthorized`, 404 `not_found` (also unknown routes), 413 `too_large` (over `MAX_BODY_BYTES`),
  429 `over_budget`, 500 `internal`. A business failure (no pages, a refused site) is a `failed` job, not an HTTP error.
- **CORS** for the web preview: `OPTIONS` answers 204 with `Access-Control-Allow-Origin: *` and allows
  `Authorization, Content-Type` and `GET, POST, OPTIONS`.
- **`/health`** is `{"ok": true, "version": "<git sha>"}` (or `VERSION` from the environment), with no upstream calls.
- **Jobs.** Search steps `search` → `verify` → `rank` (percent moves 5 → 70 with the clock while the web search runs;
  verify and rank stay on screen about a second each); build steps `probe` → `build` → `gate` → `merge`; scrape steps
  `scrape` → `taxonomy` → `save`. At most `MAX_PARALLEL_SEARCHES` searches and `MAX_PARALLEL_SCRAPES` scrapes run at
  once; the rest wait in their job.
- **Search.** Page ids come from the URL (the app's `pageIdFor`), so the same page has the same id in every search and a
  re-scrape replaces its listing. Results are cached by (product id, scanType, includeSimilar) for
  `SEARCH_CACHE_HOURS`. A product without a photo gets one from Open Food Facts ([server/photo.py](server/photo.py), the
  app's `match.ts`); a `user_photo` (a file on the scanning phone) is never stored for the team.
- **Caps.** A paid web search (no recorded result, nothing cached) counts against `MAX_SEARCHES_PER_DAY`, a new
  scraper build against `MAX_BUILDS_PER_DAY`; over the cap the POST answers `429 over_budget`. Counters reset at local
  midnight and on restart.
- **Merge by pageId.** One listing per (product, page): a unique index in Postgres (migration `0001` removed older
  duplicates, keeping the newest) and an upsert; the JSON store merges the same way. `GET /products/:id/listings` also
  lists `failures`: pages whose latest scrape failed and that have no listing since.
- **One product, one id.** [server/products.py](server/products.py) keys products: a valid barcode makes the id
  `gtin-<GTIN-14>` (7315122013887, 07315122013887 and 007315122013887 are one product, whatever the name); without
  one, a scan reuses the stored product with the same name key (brand + name + size, accents, case, punctuation and
  units ironed out: "100 gr" = "100 g", "1 l" = "1000 ml"). A barcode with a wrong check digit is kept as given and
  never equals a valid one. `POST /products`, `POST /search` and scrapes answer with that canonical id; stored rows
  that turn out to be the same product fold into it (pages, searches, runs, listings move; the newest listing per
  page stays), the latest non-empty fields win and a known barcode is never dropped. Old ids live on in
  `product_aliases`, so `GET /products/:old` still answers. Product writes take one advisory lock; a unique index on
  `gtin` is the backstop. The JSON store (no `DATABASE_URL`) keys products the same way, with aliases under `aliases/`.
- **Logs.** One line per request (method, path, status, ms, jobId) and per finished job (kind, status, ms, provider,
  and for a Claude search its model, tokens, searches and estimated US$; for a build the builder's cost). Never the
  Authorization header, a key, or client addresses.

## Database

Products, the pages found for them, scrape runs, listings and scraper builds go to Postgres when `DATABASE_URL` is set; without it
everything stays in JSON files under `DATA_DIR`. Start a local Postgres 16 with one command:

```
docker compose up -d                          # postgres:16 on localhost:5433, volume scanner-pg
DATABASE_URL=postgresql://scanner:scanner@localhost:5433/scanner uv run python -m server
```

A Postgres you already run works too (e.g. Postgres.app on 5432: `createdb scanner`, then
`DATABASE_URL=postgresql://localhost/scanner`). The server applies new migrations on start; to apply them by hand:
`DATABASE_URL=... uv run python -m server.db migrate`.

The schema is defined with [Drizzle](https://orm.drizzle.team) in [db/schema.ts](db/schema.ts), the single source of
truth; drizzle-kit generates the SQL migrations into [db/drizzle/](db/drizzle/) and the Python server applies them
(it queries with psycopg). To change it:

```
cd db && npm install                          # once
# edit schema.ts
npm run generate                              # writes drizzle/NNNN_<name>.sql and its meta/ snapshot; commit both
                                              # the server applies it on its next start (or: uv run python -m server.db migrate)
npm run check                                 # drizzle-kit check: the migration history is consistent
npm run studio                                # browse the data (DATABASE_URL, default postgresql://localhost/scanner)
```

[server/db.py](server/db.py) reads `drizzle/meta/_journal.json` for the order, runs each file's statements in one
transaction and records its tag in `schema_migrations`. That table is the only tracker: don't run
`drizzle-kit migrate` or `drizzle-kit push` against these databases. A database created before Drizzle (its
`schema_migrations` lists `001_init.sql`) already has the same schema, so it records `0000_init` as applied
without running it. The tables:

| Table | Key columns |
|---|---|
| `products` | `id` (ProductIdentity.id: `gtin-<GTIN-14>` or a name slug), brand, product_name, variant, size, `barcode` (as given), `gtin` (unique, NULL without a valid barcode), `name_key` (indexed), manufacturer, category, image_url, image_source, source, confidence, `extra` jsonb |
| `product_aliases` | `old_id` → product_id: ids a product had before a merge or its move to a `gtin-` id |
| `retailers` | `domain`, name, kind (`first_party` / `third_party`) |
| `searches` | `id` (searchId), product_id, created_at, `raw` jsonb (the SearchResult) |
| `pages` | `id`, product_id, retailer_domain, search_id, url, title, match_type, verification_*, access_*, scraper_status, scraper_id, `extra` jsonb |
| `scrape_runs` | `id` (runId), product_id, started_at, finished_at, status, `failures` jsonb |
| `listings` | `id`, page_id, product_id, scrape_run_id, url, title, price_amount, price_currency, availability, image_url, `fields` jsonb, `extra` jsonb, scraped_at |
| `builds` | `id` (buildId), domain, url, kind, provider, product_id, page_id, state, stage, note, source, session_url, pr_url, branch, attempt, max_attempts, `access` jsonb, `cost` jsonb, started_at, ended_at |
| `build_attempts` | (build_id, `n`), started_at, ended_at, outcome, verdict, passed, total, `failed` jsonb, sent_back, notes, `gate` jsonb (the gate's report) |
| `build_events` | (build_id, `seq`), at, kind, stage, message, attempt, `extra` jsonb |

Writes happen in [server/app.py](server/app.py) through [server/db.py](server/db.py): a finished search saves its
product, search and pages; a scrape saves its run and upserts one listing per (product, page); a passed build marks its host's pages `available`. `GET /scans`, `GET /products`,
`GET /products/:id` and `GET /products/:id/listings` read from Postgres. Every build is written as it happens
(its row, each attempt with the gate's report, every event), and `GET /builds` and `GET /builds/:id` read it. On
start the server imports builds the JSON store under `DATA_DIR` recorded before the database was on; for other
folders: `DATABASE_URL=... uv run python -m server.db import-builds DATA_DIR ...`. Jobs stay in memory.

Migration `0002_products_by_gtin` adds `gtin`, `name_key` and `product_aliases`; its data step runs in Python right
after it (`Database.dedupe`, so it shares server/products.py with the writes): every product without a `name_key`
is saved again over itself, oldest first, which moves barcoded products to their `gtin-` id and folds duplicates in.
It only touches rows without a `name_key`, so it is a no-op once done.

Tests against a real server: `createdb scanner_test` once, then
`TEST_DATABASE_URL=postgresql://localhost/scanner_test uv run --group dev pytest -q` (each test migrates and drops a
throwaway schema; without the variable those tests skip).

## A build

[server/builds.py](server/builds.py). The backend is the manager, the builder is a worker, the gate is the judge.

1. **Access.** robots.txt and its rule for AI agents ([kit/robots.py](../scraper-kit/kit/robots.py)). A refused site
   ends the build here: no session starts.
2. **Exists?** A source already collecting the host ends the build as `exists`.
3. **Probe.** `kit probe` runs in the backend; its report goes into the builder's prompt.
4. **Attempt.** The builder works under the [build-source skill](../.agents/skills/build-source/SKILL.md) and reports
   with [the output schema](../scraper-kit/devin/output.schema.json). Its progress reaches the app as it happens.
5. **Gate.** The backend stages the trusted kit with only the builder's `sources/<SOURCE>.py` and
   `fixtures/<SOURCE>/`, runs `kit gate --live` in a subprocess, and adds `allowed_paths` (nothing else changed).
   What the builder says about its work does not count.
6. **Fail:** the gate's report goes back to the **same** session, which keeps its context, up to `MAX_ATTEMPTS`
   (3), then the build waits for a person. `unreachable` is the network: retried once, never sent back.
   **Pass:** the two paths are merged into the live kit and every saved page on that host gets `available`.
   With Devin, its PR also merges through CI ([scraper-kit-merge.yml](../.github/workflows/scraper-kit-merge.yml)).

One build per host at a time (Devin v3 has no idempotency key). `POST /scrapers/build-batch` starts one build per
missing site, and up to `MAX_PARALLEL_BUILDS` (4) sessions run at once.

Every build is recorded as it happens, in `data/builds/` and `data/gates/` and, with `DATABASE_URL`, in Postgres.
`GET /builds` lists them newest first with a tally per site; `GET /builds/:id` returns one build's attempts, every
event and each gate report. The log has one `build` line per event and a `build.end` line per build (state, attempts,
source, PR, cost, seconds); a backend error ends a build `failed` with what went wrong, never `building`.

## Builders

[server/runners.py](server/runners.py), one interface: `attempt(run, message, emit)`, `candidate(run, output)`.

| `AGENT=` | What runs | Result |
|---|---|---|
| `devin` (default) | A Devin v3 session: `POST /v3/organizations/{org}/sessions` with the repo, the output schema, an ACU cap and tags; polled every 12 s; a failed gate is a message to the same session | A branch `source/<SOURCE>` and a PR; the backend fetches the branch into `REPO_CLONE` to gate it |
| `claude_code` | Headless `claude -p` in a copy of the kit, the skill inlined, `--resume` for a retry | `run-report.json` in the workspace |
| `scripted` | No agent: replays a recorded build from [fixtures/builds/](fixtures/builds/)`<domain>/` (its source, fixtures and `report.json`); the gate still judges it. Free; a domain without a recording fails the build | |

Devin's field names (status, status_detail, structured_output, pull_requests, acus_consumed) follow the v3 API
reference at docs.devin.ai.

## Settings

| Variable | Default | |
|---|---|---|
| `AGENT` | `devin` | `devin`, `claude_code`, `scripted` (see Builders; also [docs/claude-and-devin.md](../docs/claude-and-devin.md)) |
| `DEVIN_API_KEY`, `DEVIN_ORG_ID` | | Read from the environment only; never written to a file, log or prompt |
| `DEVIN_REPO` | `HarryGomar/hackathon-devin-shelvin` | The repo Devin works in |
| `DEVIN_BASE_BRANCH` | `main` | The branch Devin starts from and opens its PR against |
| `DEVIN_MAX_ACU`, `DEVIN_MODE` | `8`, unset | Per-session ACU cap; `devin_mode` if set |
| `REPO_CLONE` | this checkout | Where Devin's branches are fetched for the gate |
| `MAX_PARALLEL_BUILDS`, `MAX_ATTEMPTS`, `ATTEMPT_MINUTES` | `4`, `3`, `30` | |
| `SEARCH` | `fixtures` | Recorded results in `fixtures/search/` always come first. When none matches: `fixtures` fails the search; `claude`, the app's Claude web search through the Messages API ([server/web_search.py](server/web_search.py), needs `ANTHROPIC_API_KEY`); `devin`, a Devin session with the same prompt and answer schema ([server/devin_search.py](server/devin_search.py), needs `DEVIN_API_KEY`/`DEVIN_ORG_ID`, untested live); `agent`, headless Claude Code |
| `DEVIN_SEARCH_MAX_ACU` | `2` | ACU cap of one Devin search session |
| `GATE_LIVE` | `1` | `0` runs only the gate's offline checks (no network for the gate) |
| `SCRIPTED_PAUSE_SECONDS` | `1.5` | `AGENT=scripted`: pause between replayed progress lines, so the app shows them |
| `SEARCH_MODEL`, `SEARCH_TIMEOUT_SECONDS` | `claude-opus-5-5`, `180` | For `SEARCH=claude` |
| `SEARCH_SIMILAR_MODEL`, `SEARCH_MAX_USES` | `claude-sonnet-5-5`, `6` | The similar-products call's model; web searches for the exact pages (`4` is the fast setting, see Search) |
| `DATABASE_URL` | unset | Postgres for products, pages, scrape runs and listings (see Database) |
| `API_TOKEN` | unset | The team token; unset turns auth off (local dev only), and the server then listens on 127.0.0.1 only |
| `HOST` | `0.0.0.0` with a token, else `127.0.0.1` | Listen address |
| `MAX_BODY_BYTES` | `1000000` | Larger bodies get `413 too_large` |
| `MAX_SEARCHES_PER_DAY`, `MAX_BUILDS_PER_DAY` | `60`, `20` | Daily caps on paid web searches and new builds (`429 over_budget`) |
| `MAX_PARALLEL_SEARCHES`, `MAX_PARALLEL_SCRAPES` | `2`, `4` | Jobs running at once; the rest queue |
| `SEARCH_CACHE_HOURS` | `6` | How long a web search's pages are reused for the same product, scan type and similar flag |
| `VERSION` | the git sha | What `/health` reports |
| `KIT_DIR`, `DATA_DIR`, `PORT` | `../scraper-kit`, `./data`, `8791` | |

The gate subprocess and the Claude Code builder get no `DEVIN_*`, `AWS_*` or (for the gate) `ANTHROPIC_*`
variables. A builder's code never runs in the backend's process: routing (search, match, build-batch, scrape) reads
each source's `SOURCE`/`ORIGIN`/`RETAILER`/`KIND` from its file text, the gate runs it in a subprocess on a staged
copy of the kit, and a scrape runs it in a child process ([server/collect.py](server/collect.py)) that gets no
`DEVIN_*`, `ANTHROPIC_*` or `AWS_*` variables.

## Search

`POST /search` matches a recorded search in [fixtures/search](fixtures/search) by barcode, then brand and name
(Takis Fuego 56 g is recorded from a real agent search). With `SEARCH=claude` an unknown product goes to the app's
Claude web search (Mexican retailers plus the brand's own site; an empty answer is retried once, then the job fails
with a reason; each run's raw answer, usage and cost is saved under `data/search_runs/`). Each page then gets `access` from the kit, and a refused one gets a short label and an official
alternative (Amazon's Creators API, Mercado Libre's OAuth API, PROFECO's price data).

How the Claude search runs ([server/web_search.py](server/web_search.py)), each choice measured with
[tools/search-benchmark](../tools/search-benchmark/bench.py) (10 products sold in Mexico with real barcodes and a
hand-checked key of the pages that sell exactly that brand, flavor and size):
- **Basic web search tool, searches sent together.** `web_search_20250305` returns results straight away, where
  `web_search_20260209` spends model turns writing filter code; the prompt asks for the searches as parallel calls in
  the first step.
- **The barcode is evidence, not a query.** A bare barcode search returns unrelated pages, so the model is told that
  Walmart and Bodega Aurrera URLs end with the GTIN without its check digit. A page whose URL or title has the
  barcode is `verified`; a Walmart-family URL with another code, or a title naming another size, is not.
- **Similar products are their own call**, on `SEARCH_SIMILAR_MODEL` at low effort with 4 searches, run next to the
  exact search; it may fail or be late (30 s grace) without touching the exact pages (`run.similarError`).
- **Verify step:** robots access for every page runs in parallel, then a link check (one GET, 4 s, only where
  robots.txt allows the kit) drops 404/410 pages and pages that redirect to a home or search page, and downgrades a
  `verified` page whose live title names another size (`job.log.links`).
- **Cache** by product id and by barcode.

| Run (10 products, includeSimilar off) | precision | recall | wrong verified | dead URLs | p50 / p90 s | US$ / search |
|---|---|---|---|---|---|---|
| Dynamic-filter tool, 6 searches, effort medium | 83% | 78% | 0 | 0/47 | 33.3 / 39.3 | 0.31 |
| Barcode evidence + size rules, same tool | 100% | 74% | 0 | 0/37 | 31.7 / 37.0 | 0.30 |
| + basic tool (the default, with parallel searches) | 96% | 83% | 0 | 0/47 | 20.9 / 30.1 | 0.41 |
| `SEARCH_MAX_USES=4` (fast) | 98% | 72% | 0 | 0/40 | 13.6 / 19.0 | 0.25 |

With similar products (3 products): p50 18.6 s and US$0.48, against 42 to 46 s with both in one call. Precision is
over the exact pages not rejected; recall counts the key's items found (a store's item id, so URL variants count once).
