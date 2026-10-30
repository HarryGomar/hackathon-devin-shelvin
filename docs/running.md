# Running Shelvin end to end

The phone app (`app/`, Expo) talks to the backend (`backend/`, Python on :8791). The backend runs the scrapers in
`scraper-kit/` and keeps data in JSON files, or in Postgres with `DB=postgres`. Identification (barcode → product)
runs on the phone. Page search, scraper builds and scrapes run on the backend.

## 1. Once

- [uv](https://docs.astral.sh/uv/) (it fetches Python 3.12 by itself), Node 22.15+ and the Expo toolchain (`cd app && npm install`).
- For `DB=postgres`: `brew install postgresql@16` (nothing to configure; dev-up creates the cluster).
- For real Claude calls: `EXPO_PUBLIC_ANTHROPIC_API_KEY=…` in `app/.env` of the main checkout (the phone's
  identification already uses it). dev-up passes it to the backend as `ANTHROPIC_API_KEY` without printing it.

## 2. Start the backend

```bash
scripts/dev-up.sh
```

Defaults are free: `SEARCH=fixtures` (recorded searches only), `AGENT=scripted` (recorded builds only), JSON
storage in `backend/data/`. It prints three lines for the app:

```
EXPO_PUBLIC_API_MODE=live
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:8791
EXPO_PUBLIC_API_TOKEN=<the team token, kept in backend/data/.api-token>
```

Options (combine freely; [claude-and-devin.md](claude-and-devin.md) has costs):

| | |
|---|---|
| `SEARCH=claude` | real page search for any product (~US$0.36 each) |
| `AGENT=claude_code` | real scraper builds with headless Claude Code |
| `SEARCH=devin` / `AGENT=devin` | Devin (needs `DEVIN_API_KEY`, `DEVIN_ORG_ID` in your shell) |
| `DB=postgres` | Postgres 16 on localhost:5433, data in `backend/data/postgres`; migrations apply on start |
| `MAX_SEARCHES_PER_DAY`, `MAX_BUILDS_PER_DAY` | daily caps on paid searches (60) and new builds (20); over the cap the backend answers `429 over_budget` |
| `PORT`, `DATA_DIR`, `API_TOKEN`, `ENV_FILE` | override the defaults |

Stop it with Ctrl-C. Postgres keeps running; dev-up prints its `pg_ctl … stop` line.

## 3. Point the app at it

Put the three lines in `app/.env` and keep `EXPO_PUBLIC_IDENTIFY_MODE=live` (identification on the phone). Then:

```bash
cd app && npx expo start -c
```

Press `i` for the iOS Simulator, or scan the QR code with Expo Go on an iPhone on the same Wi-Fi
([phone/expo-go.md](phone/expo-go.md)). The simulator reaches the Mac's LAN address as well as `localhost`.

## 4. Check it

```bash
cd tools/contract-check && npm install
BASE_URL=http://127.0.0.1:8791 TOKEN=$(cat ../../backend/data/.api-token) npm run check
```

It searches Doritos Nacho 61 g (recorded, so free with `SEARCH=fixtures`), builds a scraper for a page without one,
scrapes and reads back the saved listings. Another product, with the app's id (`gtin-` + the GTIN-14):

```bash
npm run check -- --product '{"id":"gtin-07501030424536","brand":"Takis","productName":"Takis Fuego","variant":"Fuego","size":"56 g","barcode":"7501030424536","confidence":0.9,"source":"claude"}'
```

Expect no failures. A few warnings are normal: no store lists breadcrumbs, Barcel's catalog and Walmart's
out-of-stock page have no real price, and `AGENT=scripted` has no recording for the site it tries to build.

Backend tests: `cd backend && uv run --group dev pytest -q`. Add Postgres with
`createdb -h localhost -p 5433 -U scanner scanner_test` and
`TEST_DATABASE_URL=postgresql://scanner@localhost:5433/scanner_test`. Kit tests: `cd scraper-kit && uv run --group dev pytest -q`.

## 5. The flow to try

1. **Scan** a barcode or type one; the phone identifies it (Open Food Facts, then Claude; a web search for thin
   records), and you confirm the product. Recorded (free) searches:
   - Takis Fuego 56 g `7501030424536`: Office Depot (MXN 22.00), Chedraui and Barcel have scrapers; Walmart and
     Soriana have none. If identification can't name it, type it in on Confirm
     (Takis · Takis Fuego · Fuego · 56 g).
   - Takis Fuego 70 g `7500810003671`: Barcel's catalog matches; Chedraui is uncertain (it sells
     other sizes). No store page we can scrape sells 70 g.
   - Doritos Nacho 61 g `7501011123588`: Chedraui has a scraper; Walmart, Bodega Aurrera, H-E-B and Soriana have none.
2. **Pages found**: the backend's search. Each page shows its retailer, verification and scraper. Amazon, Mercado
   Libre and Rappi are **BLOCKED** (robots.txt blocks AI agents), La Comer too (robots.txt disallows). Each shows its
   official alternative and offers no build.
3. **Build scraper** on a page whose site has none, or **Build all missing**. With `AGENT=scripted` only recorded
   builds replay (Office Depot, which the kit already ships; see [claude-and-devin.md](claude-and-devin.md) to replay it); any other site
   fails at once with "no recorded build". With `AGENT=claude_code` or `devin` any allowed site gets a real build.
   The live panel shows probe → build → gate → merge; **trace** opens the build's full recording.
4. **Scrape** the selected pages: the listings with prices, the brand site (Barcel) read as its whole catalog (no
   prices there), and failures grouped as Blocked by the site / Couldn't fetch.
5. **Home** lists the saved scan; opening it shows the saved listings (`GET /products/:id/listings`). **Builds**
   (Home) lists every build with its attempts, events and gate reports (`GET /builds`).

A passed build merges into the live kit (`scraper-kit/sources/`). `git checkout -- scraper-kit/sources
scraper-kit/fixtures` puts the kit back as committed.

## Troubleshooting

- **401 "Missing or wrong team token"**: `EXPO_PUBLIC_API_TOKEN` doesn't match `backend/data/.api-token`. Restart
  Expo with `-c` after editing `.env`.
- **The phone can't connect**: same Wi-Fi as the Mac; use the LAN address dev-up printed, not `localhost`. Without
  `API_TOKEN` the backend only listens on 127.0.0.1.
- **"No pages found … (no recorded search)"**: the product isn't recorded. Use `SEARCH=claude`.
- **"no recorded build for <site>"**: `AGENT=scripted` has no recording for that site. Use `AGENT=claude_code`.
- **Postgres "postmaster became multithreaded during startup"**: a missing locale. dev-up sets
  `LC_ALL=en_US.UTF-8` for Postgres (`PG_LC_ALL` overrides it).
