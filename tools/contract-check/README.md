# contract-check

Checks a Shelvin backend against [`docs/backend-spec.md`](../../docs/backend-spec.md). It calls every endpoint in the
order the app does, checks each body's shape, polls the jobs like the app (every 1 s), and checks auth and the error format.
Identification runs in the app, so there is no `/identify` check: the search sends a sample confirmed product
(Doritos Nacho 61 g, barcode `7501011123588`).

Needs Node 22.15 or newer. No app code runs here: `src/types.ts` is a copy of `app/src/api/types.ts`, kept in sync
by a test.

```bash
cd tools/contract-check
npm install
BASE_URL=https://your-server.example.com TOKEN=the-team-token npm run check
```

| Command | What it does |
|---|---|
| `npm run check -- --mock` | Runs against a built-in local stub (`src/stub.ts`). No network and no cost. The stub is a shape reference, not a backend. |
| `npm run check -- --no-search` | Skips search, scraper build and scrape. On a real server a search and a build can cost money (an agent web search, a builder session). |
| `npm run check -- --product '{"id":"gtin-07501030424536","brand":"Takis",…}'` | Searches this confirmed product instead of the Doritos sample. The id is the app's (`gtin-` + GTIN-14 with a barcode); `GET /scans` and the listings are checked under that canonical id. |
| `npm run check -- --json` | Prints the results as JSON. |
| `npm test` / `npm run typecheck` | The checker's own tests (they run the checker against the stub, with and without injected faults). |
| `npm run sync-types` | Copies the app's contract types again after they change. |

Env: `BASE_URL`, `TOKEN`, `POLL_MS` (default 1000), `JOB_TIMEOUT_MS` (default 150000).

Each check prints one of these:
- `PASS`
- `WARN`: legal, but the app will look worse, for example no price or no breadcrumb.
- `FAIL`: the app would break or show something wrong.
- `SKIP`

The exit code is 1 if anything failed. Every issue names the JSON path, for example
`result.pages[3].similarProductId: must be the id of one of similarProducts`.

The run creates real data on the server: one search, one scraper build and two scrapes of the same product, which
also checks the merge by pageId. If the search returns a page with `access` refused, one more scrape sends just that
page and checks it comes back in `failures` with its access `code`, never as a listing. The stub (`--mock`) has one
refused page (Amazon, `ai_opt_out`) and one store that answers 403 when scraped (HEB, a `blocked` failure).
