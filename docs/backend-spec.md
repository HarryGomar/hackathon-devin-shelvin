# Shelvin backend spec

This spec describes the Shelvin backend without assuming you know the app: what the backend does, what the app sends
and expects, and how to check a server before the app uses it.

- **Field-level contract:** [`docs/api-contract.md`](api-contract.md). The TypeScript source of truth is
  [`app/src/api/types.ts`](../app/src/api/types.ts). Names are fixed: you may add fields, but don't rename or remove any.
- **Checker:** [`tools/contract-check/`](../tools/contract-check/README.md) runs every endpoint against your server and
  tells you what the app would trip on (`BASE_URL=… TOKEN=… npm run check`).
- **Who does what:** identification (barcode or photo → product) **stays on the phone**; the backend has no
  `/identify`. Page search runs **on the backend** (`POST /search`, `backend/server/search.py`): the brand's site
  first, then Mexican retailers, with robots.txt checked for every page. See §6 and §7.

Contents:
1. [What the app does](#1-what-the-app-does)
2. [Connection rules](#2-connection-rules)
3. [Endpoints](#3-endpoints)
4. [Jobs](#4-jobs)
5. [Endpoint details](#5-endpoint-details)
6. [Identification (in the app)](#6-identification-in-the-app-not-on-the-backend)
7. [Page search](#7-page-search-post-search)
8. [Scrapers](#8-scrapers)
9. [Persistence](#9-persistence)
10. [Secrets, cost and logging](#10-secrets-cost-and-logging)
11. [Acceptance](#11-acceptance-done-means)

## 1. What the app does

Shelvin is an iPhone app (Expo / React Native) for a small team. Someone scans a packaged product in a Mexican store
(barcode or photo). The app works out exactly which product it is. It then finds the pages that sell that product
online: the brand's own page and Mexican retailers. It scrapes those pages for price, category and other details and
saves the results so the whole team sees them.

| # | Screen / step | What happens | Who does it |
|---|---|---|---|
| 1 | Scan | Barcode scan, typed barcode, or a photo of the pack. | App (camera) |
| 2 | Identify | Barcode or photo → brand, product, flavor, size, maker, photo. | **App** (Open Food Facts + Claude from the phone, §6). No backend endpoint. |
| 3 | Confirm | The user checks the product, fixes it if needed, picks first party / third party / both and "include similar". | App |
| 4 | Find pages | Pages that sell exactly this product (and similar products): the brand's site first, then Mexican retailers, each one verified and checked against robots.txt. | **Backend** `POST /search` job (§7). While the backend is mocked, the app can run its own Claude search instead. |
| 5 | Scrapers | Which pages' sites have a scraper. Build one for a site that has none, or for a URL the user pastes. | **Backend** `POST /scrapers/match`, `POST /scrapers/build` job |
| 6 | Scrape | Scrape the pages the user picked and save the listings. | **Backend** `POST /scrape` job |
| 7 | Results / Home | Listings for this product. Home shows recent scans from the whole team. | **Backend** `GET /products/:id/listings`, `GET /scans` |

There is no login. Everyone with the team token sees and adds to the same data. The region is always Mexico (`"MX"`)
and prices are MXN. The app's UI is in English; product names and retailer breadcrumbs stay in Spanish as printed.

## 2. Connection rules

**Base URL.** One origin, with all paths at its root, for example `https://shelvin-api.example.com/search`. The app reads it
from `EXPO_PUBLIC_API_BASE_URL` (no trailing slash needed). **Use HTTPS** for anything outside your own Wi-Fi, because
the token travels with every request. Plain `http://<lan-ip>:<port>` works for testing on one Wi-Fi network (Expo Go
allows it). Phones that open the app through `expo start --tunnel` may not be on your network, so the backend must
then be reachable from the internet; see [`docs/phone/expo-go.md`](phone/expo-go.md).

**Health.** `GET /health` → `200 {"ok": true, "version": "<git sha or semver>"}`. It needs no token and makes no
upstream calls. It should answer within 1 s.

**Auth: one shared team token.**
- Every request except `/health` carries `Authorization: Bearer <token>`.
- The app gets the token from `EXPO_PUBLIC_API_TOKEN`.
- A missing or wrong token gets `401 {"error": "…", "code": "unauthorized"}`.
- Keep the token in your server's env (for example `API_TOKEN`) and compare it in constant time.
- This is a speed bump, not real security: `EXPO_PUBLIC_*` values are bundled into the app, so anyone who has the
  bundle has the token. It exists so a leaked URL can't run up the Claude bill. Rotate it if it leaks, and keep the
  cost caps in §10.

**CORS.** Not needed for the iPhone: Expo Go makes native requests and has no browser origin. You need it only if
someone uses the web preview (`npx expo start --web`, origin `http://localhost:8081`): answer `OPTIONS` preflights,
allow `GET, POST, OPTIONS` and the headers `Authorization` and `Content-Type`, and send `Access-Control-Allow-Origin`.
For a team-only server, `*` or the dev origin is fine.

**JSON.**
- Requests and responses are `Content-Type: application/json` in UTF-8. Spanish accents are normal ("Incógnita").
- Times are ISO 8601 UTC (`2026-10-28T18:30:00.000Z`).
- Prices are numbers in major units: `{"amount": 21.5, "currency": "MXN"}`.
- Ignore request fields you don't know. The app may send more than this spec lists, for example extra
  `ProductIdentity` fields on the product it sends to `/search`.

**Errors.** Every non-2xx response has this body:

```json
{ "error": "Product doritos-incognita-62-g not found", "code": "not_found" }
```

`error` is a **string** and the app shows it to the user as is. Keep it short, human and in English. `code` is
optional and machine-readable.

The body must be flat. The app's client ([`app/src/api/http.ts`](../app/src/api/http.ts)) reads `error` as a string,
so a nested `{"error": {"code", "message"}}` would show "[object Object]". The checker fails the nested form.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body is missing, not JSON, or has wrong types (for example `POST /search` with `{}`). |
| 400 | `invalid_url` | `POST /scrapers/build` with something that isn't an http(s) URL. |
| 401 | `unauthorized` | The token is missing or wrong. |
| 404 | `not_found` | Unknown job id, unknown product, or unknown route. |
| 413 | `too_large` | The body is over your limit (1 MB is plenty; the app sends no photos). |
| 429 | `rate_limited` / `over_budget` | Too many requests, or a daily cost cap was hit (§10). Say when to try again. |
| 500 | `internal` | A bug. Log it and keep the message generic. |
| 502 | `upstream_failed` | The search agent, a builder or a retailer failed in a way the user can retry. |

A **job** that fails for a business reason (search found nothing, site blocked) is not an HTTP error: `GET /jobs/:id`
answers `200` with `status: "failed"` and `error` (§4).

**Timeouts.**

| Request | Answer within |
|---|---|
| Plain requests (`/health`, `/scrapers/match`, `/scans`, `/products/:id/listings`, `GET /jobs/:id`) | **2 s** (the app's budget is 20 s) |
| POSTs that start a job | **1 s**: create the job, return it, and do the work in the background |

Anything slower must be a job.

## 3. Endpoints

| Method and path | Sync? | Returns |
|---|---|---|
| `GET /health` | sync | `{ ok, version? }` |
| ~~`POST /identify`~~ | — | **Not needed:** identification runs in the app |
| `POST /search` | job | `Job<SearchResult>` |
| `POST /scrapers/match` | sync | `{ matches: ScraperMatch[] }` |
| `POST /scrapers/build` | job | `Job<BuildScraperResult>` |
| `POST /scrape` | job | `Job<ScrapeResult>` |
| `GET /jobs/:jobId` | sync | `Job<T>` |
| `GET /scans` | sync | `{ scans: ScanSummary[] }` |
| `GET /products/:productId/listings` | sync | `ProductListings` |

The other endpoints (`POST /scrapers/build-batch`, `GET /builds`, `POST /products`, `GET /products`,
`GET /products/:productId`, `GET /builds/:buildId`) are in [`api-contract.md`](api-contract.md). In mock mode the app
uses an in-memory mock of this contract instead (`app/src/api/mock/`).

## 4. Jobs

`POST /search`, `POST /scrapers/build` and `POST /scrape` create a job and return it right away (HTTP 202 or 200):

```json
{ "jobId": "search_k9x2a7", "status": "queued", "progress": { "step": "search", "message": "Searching Mexican stores for Doritos Nacho", "percent": 5 } }
```

The app then polls `GET /jobs/:jobId` **once a second** ([`app/src/hooks/use-job.ts`](../app/src/hooks/use-job.ts)) until
`status` is `succeeded` or `failed`. Lifecycle: `queued` → `running` → `succeeded` with `result`, or `failed` with `error`.
`jobId` never changes. An unknown id gets `404`.

`progress.step` must be one of these keys, in this order. The app draws all the steps up front and ticks them off as
`step` advances. An unknown key leaves the app stuck on the first step. `message` is shown under the steps; make it
specific ("Found 9 pages on 6 sites; checking each is the same product"). `percent` (0–100) is optional. When the job
succeeds, `step: "done"` is fine.

| Job | `step` keys, in order (the app's label) | Where the app draws them |
|---|---|---|
| search | `search` "Searching the web" → `verify` "Checking each page" → `rank` "Ranking official pages and retailers" | [`sources-screen.tsx`](../app/src/features/sources/sources-screen.tsx) (its fourth step, `scrapers`, is the app's own `POST /scrapers/match` call afterwards) |
| scraper build | `probe` "Checking the site" → `build` "Building the scraper" → `gate` "Testing it on the page" → `merge` "Making it live" (a failed gate goes back to `build` for the next attempt) | [`add-source-screen.tsx`](../app/src/features/sources/add-source-screen.tsx) |
| scrape | `scrape` "Scraping the pages" → `taxonomy` "Mapping categories" → `save` "Saving listings" | `sources-screen.tsx` |

**Retention.** Keep finished jobs for at least **1 hour**. The app may poll once more after a screen comes back. Jobs can
live in memory if you run one process; if the server restarts mid-job, the app gets a 404 and shows an error with
Try again, which is acceptable. **Concurrency:** expect a few phones at once. Run the jobs in a small queue (for example
2 searches and 4 scrapes at a time) rather than unbounded.

## 5. Endpoint details

Full field lists are in [`api-contract.md`](api-contract.md). These are the examples and the rules that matter.

### `POST /identify`: not needed

Identification runs in the app (§6). The backend first sees a product in the body of `POST /search`.

### `POST /search` → `Job<SearchResult>`

```json
{
  "product": { "id": "doritos-nacho-61-g", "brand": "Doritos", "productName": "Doritos Nacho", "variant": "Nacho", "size": "61 g", "barcode": "7501011123588", "manufacturer": "Sabritas (PepsiCo México)", "confidence": 0.93, "source": "claude" },
  "scanType": "both",
  "includeSimilar": true,
  "region": "MX"
}
```

`product` is whatever the user confirmed, identified on the phone (§6). It may be edited by the user
(`source: "user_edited"`), or be a similar product they tapped, which has only id, brand, name and variant. Its `id`
is the product key everywhere else. When it succeeds, `result` is:

```json
{
  "searchId": "srch_7f3k",
  "product": { "…": "the product as received; you may add imageUrl/imageSource if it had none" },
  "pages": [
    {
      "id": "web-super-walmart-com-mx-1x9c2k",
      "url": "https://super.walmart.com.mx/ip/botana-doritos-nacho-61-g/00750101112358",
      "domain": "super.walmart.com.mx",
      "retailerName": "Walmart Súper",
      "sourceType": "third_party",
      "title": "Botana Doritos Nacho 61 g",
      "matchType": "exact",
      "verification": { "status": "verified", "confidence": 0.9, "reason": "Same brand, flavor and 61 g size" },
      "scraper": { "status": "available", "scraperId": "scr-walmart" }
    },
    {
      "id": "web-soriana-com-0p2lq8",
      "url": "https://www.soriana.com/takis-fuego-70-g/7500810003671.html",
      "domain": "soriana.com",
      "retailerName": "Soriana",
      "sourceType": "third_party",
      "title": "Takis Fuego 70 g",
      "matchType": "similar",
      "similarProductId": "similar-takis-fuego",
      "verification": { "status": "verified", "confidence": 0.85, "reason": "Takis Fuego 70 g" },
      "scraper": { "status": "available", "scraperId": "scr-soriana" }
    }
  ],
  "similarProducts": [
    { "id": "similar-takis-fuego", "brand": "Takis", "productName": "Takis Fuego", "variant": "Fuego", "relation": "competitor", "reason": "Competing spicy rolled corn snack (Barcel)" }
  ]
}
```

Rules:
- `result.product.id` is the id you received.
- Page ids are unique and **stable per URL**: the same URL gets the same id in every search (the app's
  `pageIdFor(url)` in [`search/parse.ts`](../app/src/services/search/parse.ts) is one way). This is what lets a later
  scrape replace the earlier listing (§9).
- Every `similar` page's `similarProductId` is the id of an entry in `similarProducts`. With `includeSimilar: false`
  there are no similar pages and `similarProducts` is `[]`.
- `scanType` `first_party` returns only first-party pages, `third_party` only third-party pages, and `both` returns both.
- Include up to 2 `rejected` near misses (multipacks, other sizes), each with its `reason`. The app lists them,
  collapsed, and they can't be selected.
- Set `scraper` from your scraper registry (§8): `available` with `scraperId` when a scraper for that site is live,
  otherwise `missing`.
- Set `access` on every page from the kit's robots check (§8 "Refusals"). A refused page is never `available`.
- No pages at all → fail the job with a readable `error`, for example
  "No store pages found for Doritos Nacho. Check the name and size, then try again."

### `POST /scrapers/match` → `{ matches: ScraperMatch[] }`

```json
{ "urls": ["https://www.chedraui.com.mx/doritos-nacho-61g-3456789/p", "https://www.soriana.com/doritos-nacho-61-g/7501011123588.html"] }
```
```json
{ "matches": [
  { "url": "https://www.chedraui.com.mx/doritos-nacho-61g-3456789/p", "domain": "chedraui.com.mx", "status": "missing" },
  { "url": "https://www.soriana.com/doritos-nacho-61-g/7501011123588.html", "domain": "soriana.com", "status": "available", "scraperId": "scr-soriana" }
] }
```

There is one match per input URL, in the same order, with the URL echoed exactly. `status` is one of:
- `available` (needs `scraperId`)
- `missing`
- `building` (a build is running for that domain)
- `failed` (the last build failed; the app offers to build again)

A site that refuses collection (`access` refused, §8 "Refusals") is never `available`. The app keeps the page's
`access` from the search and shows it as **BLOCKED**, with no Build button.

The app calls this right after every search, so it also refreshes pages whose site got a scraper in the meantime.

### `POST /scrapers/build` → `Job<BuildScraperResult>`

```json
{ "url": "https://www.chedraui.com.mx/doritos-nacho-61g-3456789/p", "productId": "doritos-nacho-61-g" }
```

It is used for a page whose scraper is `missing`, and for a URL the user pasted on "Add a page". Not an http(s) URL →
`400 invalid_url` on the POST itself. Steps: `probe` → `build` → `gate` → `merge` (§4, §8). When it succeeds:

```json
{
  "scraperId": "scr-chedraui",
  "domain": "chedraui.com.mx",
  "page": { "id": "web-chedraui-com-mx-3k1a9z", "url": "https://www.chedraui.com.mx/doritos-nacho-61g-3456789/p", "domain": "chedraui.com.mx", "retailerName": "Chedraui", "sourceType": "third_party", "title": "Doritos Nacho 61g", "matchType": "exact", "verification": { "status": "user_added", "confidence": 1, "reason": "Added by you" }, "scraper": { "status": "available", "scraperId": "scr-chedraui" } }
}
```

- `page` is the `SourcePage` for that URL with `scraper.status: "available"`.
- Use `verification.status: "user_added"` when the URL wasn't in a search; otherwise keep the page's verification.
- Remember the page, so `POST /scrape` accepts its id.
- From then on every page on that domain matches `available`.
- A scraper that fails its test → the job `failed` with a readable `error` ("Could not find the price on
  lacomer.com.mx"). The app offers Retry, which POSTs again.
- A site that refuses collection → the job `failed` with `error` and `agentRun: { state: "refused", access, … }`.
  The app shows the page as blocked and offers no Retry.

### `POST /scrape` → `Job<ScrapeResult>`

```json
{ "searchId": "srch_7f3k", "productId": "doritos-nacho-61-g", "pageIds": ["web-super-walmart-com-mx-1x9c2k", "web-soriana-com-0p2lq8"] }
```

Steps: `scrape` → `taxonomy` → `save`. When it succeeds:

```json
{
  "runId": "run_2m8x",
  "saved": true,
  "savedAt": "2026-10-28T18:31:04.000Z",
  "listings": [
    {
      "id": "lst_8f2",
      "pageId": "web-super-walmart-com-mx-1x9c2k",
      "url": "https://super.walmart.com.mx/ip/botana-doritos-nacho-61-g/00750101112358",
      "domain": "super.walmart.com.mx",
      "retailerName": "Walmart Súper",
      "title": "Botana Doritos Nacho 61 g",
      "imageUrl": "https://i5.walmartimages.com/asr/….jpeg",
      "price": { "amount": 21.5, "currency": "MXN" },
      "categoryPath": ["Despensa", "Botanas", "Papas y totopos"],
      "standardTaxonomy": { "system": "Google Product Taxonomy", "path": ["Food, Beverages & Tobacco", "Food Items", "Snack Foods", "Chips"], "code": "2392" },
      "fields": { "net_weight": "61 g", "availability": "in_stock", "sku": "00750101112358", "gtin": "7501011123588", "promo": "3x$55", "rating": 4.6, "review_count": 128 },
      "scrapedAt": "2026-10-28T18:31:02.000Z"
    }
  ],
  "failures": [ { "pageId": "web-soriana-com-0p2lq8", "url": "https://www.soriana.com/takis-fuego-70-g/7500810003671.html", "error": "Timed out loading the page", "code": "unreachable", "retailerName": "Soriana" } ]
}
```

- Every requested page ends up in `listings` or in `failures`. Give each failure a `code` (§8 "Refusals") and the
  store's `retailerName`; the app splits them into Blocked by the site and Couldn't fetch. A run where some pages fail is still `succeeded`.
- Fail the whole job only when nothing could run, for example an unknown search.
- `saved: false` means nothing was stored; the app warns.
- Listings for `similar` pages are saved under the request's `productId`, the same as the app's mock. Their `title`
  names the similar product.

### `GET /scans` → `{ scans: ScanSummary[] }`

```json
{ "scans": [ { "product": { "…": "ProductIdentity" }, "lastScrapedAt": "2026-10-28T18:31:04.000Z", "listingCount": 5 } ] }
```

Products with at least one saved listing, newest `lastScrapedAt` first, from the whole team. 50 is enough.

### `GET /products/:productId/listings` → `{ product, listings }`

This returns the latest listing per page for that product, plus an optional `failures` list: pages of this product
whose latest scrape failed and that have no listing since (same shape as `ScrapeResult.failures`, with `code`). An
unknown product gets `404 not_found`. If the stored product's
`imageSource` is `user_photo`, its `imageUrl` is a file on the scanning phone, which nobody else can load. Drop it, or
swap in an Open Food Facts or retailer image (`imageSource: "retailer"`).

## 6. Identification (in the app, not on the backend)

Identification stays on the phone, so the backend has **no `/identify`**. The app looks the
barcode up in Open Food Facts and asks Claude to normalize it, or sends a photo to Claude vision, with its own key
([`app/src/services/identify/`](../app/src/services/identify/)). The user confirms or edits the result, and the app
sends it to `POST /search` as `product`.

What that means for the backend:
- `product.id` is `gtin-` + the GTIN-14 when the product has a valid barcode (e.g. `gtin-07315122013887`), else a stable slug of brand + name + size (e.g. `doritos-incognita-62g`). The app's `productIdFor` (`app/src/services/identify/gtin.ts`) is the source of truth. Treat it as the product key.
- `product.source` is `claude`, `openfoodfacts`, `user_edited` or `mock`; keep whatever the app sent.
- `product.imageSource: "user_photo"` means `imageUrl` is a file on the scanning phone that nobody else can load. Drop
  it, or replace it with an Open Food Facts or retailer image, before you return the product from `/scans` or
  `/products/:id/listings`.

## 7. Page search (`POST /search`)

Page search runs **on the backend** (`backend/server/search.py`; see also `backend/README.md`):
1. **The brand's own site first** (first party), then the **Mexican retailers** (third party), as `scanType` asks.
2. Where the pages come from: a recorded search in `backend/fixtures/search/` when one matches (by barcode, then
   brand and name), otherwise a paid web search by the provider `SEARCH` names (`claude`, `devin` or `agent`; see
   [`claude-and-devin.md`](claude-and-devin.md)). With the default `SEARCH=fixtures`, a product with no recorded search finds no pages.
3. **Every page gets `access`** from the kit's robots check (`kit/robots.py` `access()`). A refused page carries its
   `code`, a short `label`, the `reason` and an official `alternative`, and is never built or scraped (§8 "Refusals").
4. Each page gets its `scraper` status from the registry (§8), and the job returns the `SearchResult` in §5.

Job steps: `search` while the pages are found, `verify` while each is checked to be the same product, `rank` while
access and scraper status are attached. Hold `verify` and `rank` for about 1 s each so the user sees them tick by.
No pages at all → fail the job with a readable `error`.

**The app's in-app Claude search applies to mock mode only.** While `EXPO_PUBLIC_API_MODE` is `mock`, the app can run
a Claude web search itself (`EXPO_PUBLIC_SEARCH_MODE=claude`, wrapped by
[`claude-search.ts`](../app/src/api/claude-search.ts) in [`client.ts`](../app/src/api/client.ts)). In live mode the app
always calls the backend's `/search`. The backend's `SEARCH=claude` (`backend/server/web_search.py`) is a port of it.
Its prompts and verification rules, for reference:

<details><summary>Reference: the app's in-app Claude search (<code>app/src/services/search/</code>)</summary>

| What | Where | Notes |
|---|---|---|
| Retailer list `MX_RETAILERS`, `retailerFor(domain)` | `parse.ts` | Walmart Súper, Walmart México, Soriana, Chedraui, La Comer, Bodega Aurrera (Despensa), HEB México, Amazon México, Mercado Libre. |
| Allowed / blocked domains per `scanType`: `domainPolicy`, `brandDomainGuesses` | `parse.ts` | `third_party`: only the 8 retailer domains. `both`: retailers plus guessed brand domains (`doritos.com.mx`, `sabritas.com.mx`, …). `first_party`: an open search minus retailers, social media, Wikipedia, OFF and Profeco. |
| System prompt `SEARCH_SYSTEM`, user prompt `buildSearchPrompt`, answer schema `SEARCH_SCHEMA` | `parse.ts` | They encode the verification rules: `verified` = same brand, flavor and size; `uncertain` = size or flavor not shown, or another pack size; `rejected` = other flavor, multipack or bundle (at most 2). |
| The call: `web_search_20260209` tool with `max_uses`, `allowed_domains`/`blocked_domains` and `user_location` MX; structured output (effort `medium`); up to 2 `pause_turn` continuations; a **90 s** deadline for the whole search | `claude.ts` | Has a plain-JSON fallback for when the API rejects structured output next to web search. |
| Searches per request: `maxSearches` | `parse.ts` | 6, or 8 with similar products. |
| Validation `parseSearchResponse` → `parseSearchAnswer` | `parse.ts` | The domain decides first party / third party. Pages outside the policy or the scan type are dropped. Duplicates are merged by normalized URL. Caps: 12 exact pages, 4 similar products, 2 pages each. Order: exact before similar, first party before third party, then verified → uncertain → rejected, then confidence. Stable ids come from `pageIdFor`. |
| Anti-hallucination: `collectSeenUrls` | `parse.ts` | A URL Claude names that no search result returned is kept, but drops to `uncertain`, confidence ≤ 0.5, with the reason prefixed "Not seen in search results". |
| Readable errors: `readableError`, `SearchError` | `claude.ts`, `parse.ts` | These become the job's `error`. |
| Tests | [`parse.test.ts`](../app/src/services/search/parse.test.ts) | 14 cases with recorded responses. |

</details>

## 8. Scrapers

A **scraper** is a recipe for one site (domain) that turns a product page into a `Listing`. Keep a registry keyed by
domain:

```
{ scraperId, domain, strategy, recipe, status, lastError, testedAt }
```

`strategy` is one of `jsonld`, `store_api`, `selectors` or `headless`.

### What each endpoint does

**`scrapers/match`:** normalize the host (lowercase, strip `www.`) and look it up. Try the exact host first, then a
registered parent domain only if you know it's the same storefront. `super.walmart.com.mx` and `walmart.com.mx` are
different storefronts. While a build runs for that domain, return `building`. If the last build failed, return `failed`.

**`scrapers/build`** (the backend's builder in `backend/`; job steps in §4):
1. `probe`: the kit's robots check (a refused site stops here: the job fails with `agentRun.access`), "does a source
   already exist?", then `kit probe` to find the platform and a reader. Readers to try, in order:
   1. **JSON-LD / schema.org `Product`** with `offers.price` and `priceCurrency`, plus `BreadcrumbList` for
      `categoryPath`, `image`, `gtin13` and `sku`. Many storefronts have it, so try it first.
   2. **The store's own JSON API**, when the platform has one (VTEX, Shopify; below).
   3. **Selectors** proposed from a trimmed copy of the HTML. This is a one-off cost per site.
2. `build`: a builder session (Devin, or headless Claude Code) writes the source module and captures a fixture.
3. `gate`: the backend's own checks on a staged copy of the kit. It passes only with a title, a price in MXN and at
   least one breadcrumb level. A failed gate goes back to the same session for another `build`, up to 3 attempts;
   then the job fails with what was missing.
4. `merge`: the source goes live in the kit.

Then every known page on that domain is `available`.

**`scrape`:**
1. `scrape`: run each page's recipe. Allow at most 1–2 requests at a time per domain and 4 overall, give each page 20 s,
   and retry once.
2. `taxonomy`: map the breadcrumb.
3. `save`: store the listings (§9).

Sites with a source in the kit (`scraper-kit/sources/`) come back `available` from the first search. The mock shows Walmart Súper, Soriana, Bodega Aurrera and HEB México as ready, Chedraui and La Comer as
buildable, and Amazon and Mercado Libre as refused (`ai_opt_out`).

### What a Listing must contain

| Field | Rule |
|---|---|
| `price` | `{ amount, currency: "MXN" }` as a number: "$21.50" → `21.5`. Use the price a shopper pays now; put a crossed-out list price in `fields.list_price`. Leave `price` out rather than guess. |
| `imageUrl` | **The image on the scraped page**: JSON-LD `image`, or `og:image`, or the main product image. Must be https. Never the identified product's photo; the app relies on that (see [README](../README.md)). `null` when the page has none. |
| `categoryPath` | **The retailer's own breadcrumb**, in Spanish, as on the site, without "Inicio"/"Home" and without the product name: `["Despensa", "Botanas", "Papas y totopos"]`. |
| `standardTaxonomy` | `{ system: "Google Product Taxonomy", path, code }`, mapped on the server. Use the English names from Google's file with ids (`https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt`) and the numeric id as a string (Chips = `"2392"`). Map with a table from breadcrumbs to ids that you build as you go. When a breadcrumb isn't in the table, ask Claude once (`effort: "low"`) with the candidate leaves, and cache the answer by breadcrumb string. |
| `fields` | Everything else, flat: `string \| number \| boolean \| null`, no nesting. Use `snake_case` keys; the app turns `net_weight` into "Net weight". Useful: `net_weight`, `availability` (`in_stock`/`out_of_stock`), `sku`, `gtin`, `list_price`, `promo`, `unit_price`, `seller` (marketplaces), `rating`, `review_count`, `brand`, `scrape_strategy`. |
| `title`, `retailerName`, `domain`, `url`, `pageId`, `scrapedAt` | As on the page and its `SourcePage`. `scrapedAt` is the time you fetched it. |

### Per-site notes

Treat the platform guesses below as leads: they come from URL shapes and general knowledge. Confirm each one in a
browser's network tab before you build on it.

| Site | Domain | Product URL shape | Likely route | Caveats |
|---|---|---|---|---|
| Walmart Súper, Walmart México, Bodega Aurrera Despensa | `super.walmart.com.mx`, `walmart.com.mx`, `despensa.bodegaaurrera.com.mx` | `/ip/<slug>/<14-digit id>` | Look for JSON-LD, and for the page's embedded state JSON (for example `__NEXT_DATA__`) | **Strong bot protection** (a "Robot or human?" challenge). Expect to need a headless browser, a low rate and some failures. Check Walmart's terms before scraping. Don't solve or bypass CAPTCHAs. A blocked page is a `failures` entry. |
| Soriana | `soriana.com` | `/<slug>/<id>.html` | JSON-LD, or plain HTML selectors | Check `robots.txt`. |
| Chedraui, HEB México | `chedraui.com.mx`, `heb.com.mx` | `/<slug>/p` | The `/p` suffix suggests VTEX. VTEX stores usually have a public catalog API (`/api/catalog_system/pub/products/search/<slug>/p`) with price, images, categories and EAN | Prefer the JSON API to the HTML. |
| La Comer | `lacomer.com.mx` | varies | Unknown. Start with JSON-LD; otherwise headless, and look for the JSON the page loads | The mock treats it as "the build fails once, then works". |
| Mercado Libre | `mercadolibre.com.mx` | `/p/MLM…` (catalog), `/up/MLMU…`, `…/MLM-…` (items) | The official API (`api.mercadolibre.com`, items and products); it needs an app registered at developers.mercadolibre.com.mx | Many sellers per product: use the catalog's buy-box price and put the seller in `fields.seller`. Respect the API terms and rate limits. |
| Amazon México | `amazon.com.mx` | `/dp/<ASIN>` | The only sanctioned route is Amazon's Product Advertising API, which needs an Associates account | **Amazon's conditions of use forbid scraping**, its robots.txt blocks AI agents (the kit's robots check reports `ai_opt_out`), and its bot detection is aggressive. Return Amazon pages with `access` refused (the app shows BLOCKED) unless you have API access. Don't build a scraper that dodges the bot detection. |
| Brand sites | `doritos.com.mx`, `barcel.com.mx`, … | anything | JSON-LD, else Claude-proposed selectors | Often no price at all. A listing without a price is fine; leave `price` out. |

### Refusals

The scraper kit (`scraper-kit/kit/robots.py` `access()` and `kit/http.py`) decides whether a site lets us
collect a page and reports it as `SourcePage.access` (`PageAccess`: `status`, `code`, `reason`, `label?`,
`alternative?`). Codes and how the app groups them are in [`api-contract.md`](api-contract.md) ("Failure and access
codes"):
- the search sets `access` on every page; a refused page is never `available`, built or scraped;
- `scrapers/build` on a refused site fails the job with `agentRun.access`;
- `scrape` on a refused page puts it in `failures` with its access `code`; a run the kit stops on 401/403/429 is
  `code: "blocked"`; timeouts and network errors are `unreachable`.

The app shows **Blocked by the site** with the plain reason and the `alternative`, never a retry or a way around it.

**Etiquette:**
- Send an honest `User-Agent` with a contact, for example `Shelvin/1.0 (+you@example.com)`.
- Honour `robots.txt` and each site's terms.
- Wait 2–3 s between requests to the same domain, and cache fetched pages for an hour.
- Never log in, solve CAPTCHAs or rotate identities to get past a block.
- Use official APIs, or get a site's explicit permission, before collecting from it beyond the team's own use.

## 9. Persistence

Everything saved is shared by the whole team: there are no per-user rows. SQLite is enough. Suggested tables:

| Table | Key | Holds |
|---|---|---|
| `products` | `id` (the identity's id) | The latest `ProductIdentity` JSON the app sent for it, updated on every search |
| `searches` | `searchId` | Request, result, time |
| `pages` | `id` (from `pageIdFor(url)`) | `SourcePage` JSON, `url`, `domain`, the last `searchId` |
| `scrapers` | `domain` | Recipe, status, last error |
| `listings` | **unique (`product_id`, `page_id`)** | Latest `Listing` JSON, `scraped_at` |
| `runs` | `runId` | Who asked for what, counts, failures (for debugging) |

- **Merge by pageId.** Re-scraping a page **replaces** that product's listing for the page; it never adds a second one.
  Use an upsert on (`product_id`, `page_id`). Because page ids are stable per URL (§5), this also holds across
  searches.
- `GET /products/:id/listings` returns all listings for the product. `GET /scans` returns one row per product with at
  least one listing, with `lastScrapedAt = max(scraped_at)` and `listingCount = count(*)`, newest first.
- Keep listings until someone deletes them. Searches and runs can be pruned after 30 days.

## 10. Secrets, cost and logging

**Two sets of keys.** The app keeps its own Anthropic key (`EXPO_PUBLIC_ANTHROPIC_API_KEY`) for
identification, which runs on the phone. It is bundled into the app, so give it a monthly spend limit in the Anthropic
console. The backend's own credentials (for the search agent and the builders: `ANTHROPIC_API_KEY`, `DEVIN_API_KEY`,
…) stay on the server and never reach the app.

What costs money on the backend:
- A web search for a product with no recorded search (`SEARCH=claude`, `devin` or `agent`). The app's in-app Claude
  search, for comparison, measured **US$0.30–0.40** and 45–50 s with similar products.
- A scraper build: a builder session per site (see [`backend/README.md`](../backend/README.md) for the Devin ACU cap).

Caps to enforce on the server:
- A request body of at most 1 MB (the app sends no photos).
- Concurrency: at most 2 searches at once, and the builder's own limit (4 builds, one per host).
- Per day, a total, for example 60 agent searches. Over the cap, answer `429 over_budget`:
  "Daily search limit reached. Try again tomorrow."
- Cache searches by `(product.id, scanType, includeSimilar)` for a few hours.

**Logging:**
- Log per request: route, status, duration, `jobId`, and for agent runs the provider, duration and estimated cost.
- Product names, barcodes and URLs are fine to log.
- **Never log:** the `Authorization` header or token, any API key, or client IP addresses beyond what your host keeps
  anyway.
- Error logs get the upstream status and message, not the whole request.

## 11. Acceptance ("done means")

Run the checker until it shows no `FAIL`, and read every `WARN`:

```bash
cd tools/contract-check && npm install
BASE_URL=https://your-server TOKEN=… npm run check -- --no-search   # free checks first
BASE_URL=https://your-server TOKEN=… npm run check                   # everything: a search, a build, two scrapes
```

| Endpoint | Done means |
|---|---|
| `GET /health` | `200 {"ok": true}` in under 1 s, with no token. |
| Auth | Every other route answers `401 {"error": "…"}` with no token or a wrong one. |
| Errors | All non-2xx bodies are `{"error": "<string>", "code"?: "…"}`, with the statuses in §2. |
| `POST /identify` | **Not needed** (identification runs in the app). |
| `POST /search` | Returns a job in under 1 s. Steps go `search` → `verify` → `rank`. It finishes in under 95 s with the brand's page and verified pages from at least 3 retailers for a common product, each with `access`. Page ids are stable. `scanType` and `includeSimilar` are respected. No pages → a failed job with a readable error. |
| `POST /scrapers/match` | One match per URL, in order. The seeded retailers are `available`; a refused site never is. |
| `POST /scrapers/build` | Steps go `probe` → `build` → `gate` → `merge`. Builds a working scraper for at least one unseeded store. A bad URL returns `400 invalid_url`. A refused site is a failed job with a readable error and `agentRun.access`. |
| `POST /scrape` | Steps go `scrape` → `taxonomy` → `save`. Every page is in `listings` or in `failures`, each failure with a `code`; a refused page sent anyway is a failure with its access `code`. Listings have an MXN price, the page's own image, the retailer breadcrumb, a Google taxonomy path and code, and flat `fields`. |
| Merge | Scraping the same page twice leaves one listing for it, with the newer `scrapedAt`. |
| `GET /scans`, `GET /products/:id/listings` | They show what anyone with the token scraped, newest first. An unknown product returns `404`. |
| Secrets and cost | The backend's keys are only on the server. Daily caps work. Logs have no token or key. |

**Switching the app to your server.** In `app/.env` on the Mac that runs Expo:

```bash
EXPO_PUBLIC_API_MODE=live
EXPO_PUBLIC_API_BASE_URL=https://your-server
EXPO_PUBLIC_API_TOKEN=the-team-token
# Keep these: identification runs on the phone.
EXPO_PUBLIC_IDENTIFY_MODE=live
EXPO_PUBLIC_ANTHROPIC_API_KEY=…
# Ignored in live mode (search runs on the backend): EXPO_PUBLIC_SEARCH_MODE
```

Restart `npx expo start` after changing `.env`, because Expo reads it at start.
