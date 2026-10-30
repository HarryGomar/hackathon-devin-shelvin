# Scraper kit

The scrapers behind Shelvin's `/scrapers/match`, `/scrapers/build` and `/scrape`
([API contract](../docs/api-contract.md)). One pure module per site in `sources/`, tested offline against a
saved real capture. Devin builds new ones with the `build-source` skill; one gate decides; CI merges a green PR
that adds one source.

The rules it keeps:

| Rule | Where |
|---|---|
| A web source is one pure module; adding a site edits no shared file | `sources/<SOURCE>.py`, interface in [kit/source.py](kit/source.py) |
| A Shopify store is a declaration, not a scraper | [kit/generic/shopify.py](kit/generic/shopify.py): `bind(ORIGIN, CURRENCY)` |
| JSON-LD and Open Graph sitemap readers | [kit/generic/jsonld.py](kit/generic/jsonld.py), [og.py](kit/generic/og.py) |
| One origin per source, paced requests, stop on 401/403/429 and off-origin redirects, 8 MB cap | [kit/http.py](kit/http.py) |
| robots.txt matcher | [kit/robots.py](kit/robots.py), checked before every request and saved in the capture |
| Saved responses (cookies and embedded keys removed), replayed offline; pagination loops and rows that are not the discovered items fail | [kit/capture.py](kit/capture.py) |
| Keep every field the site sends | rows' `fields` ([kit/rows.py](kit/rows.py)) |
| Expected values written independently of the parser | `fixtures/<SOURCE>/expected.json`, a draft fails ([tests/test_sources.py](tests/test_sources.py)) |
| Look a host up before adding a source; one source per host | `kit find`, and a test that fails on a second source for a host |

## Commands

From `scraper-kit/` (Python 3.12 via uv):

```
uv run python -m kit list
uv run python -m kit find www.chedraui.com.mx
uv run python -m kit probe https://www.barcel.com.mx/productos/takis-fuego
uv run python -m kit collect barcel_mx --max-items 5
uv run python -m kit page https://www.soriana.com/doritos-incognita-62g/7500000000017.html
uv run python -m kit replay fixtures/barcel_mx/capture.json
uv run python -m kit access https://www.amazon.com.mx/dp/B000
uv run python -m kit gate barcel_mx            # offline; add --live --product '<json>' for the live checks
uv run python -m kit progress writing "Writing sources/chedraui_mx.py"
uv run --group dev pytest -q
```

`probe`, `collect`, `page`, `access` and `gate --live` use the network; everything else, and every test, is offline.

## The gate

[kit/gate.py](kit/gate.py) is the one pass/fail decision. The builder runs it before it reports, the backend runs it
on the builder's two paths in a staged copy of the trusted kit, and CI runs it on the PR. Offline it checks the
source declares its origin and kind, one source per host, the fixture exists, is small, was allowed by robots.txt
and replays, expected.json was written from the page (not the draft) and matches, and the row titles are in the
saved page. Live (`--live`) it collects again, paced and capped, and checks titles, on-site URLs, a retailer's
prices, a brand catalog's size and the scanned product, then fetches one of the pages the source read itself and
finds a row's title in it. `kit gate` exits 0 pass, 1 fail (the report goes back to the builder), 2 unreachable
(retried; never sent back).

The gate never imports the source it judges: it reads the source's constants from the file's text, runs the
source's code in a child process ([kit/worker.py](kit/worker.py)) that only prints rows, and computes every check
itself, so a source cannot change a check from inside its own file. The child is a separate process, not a sandbox.

## Access

[kit/robots.py](kit/robots.py) `access(...)` refuses a page when robots.txt disallows it, when robots.txt cannot be
read (any status but 2xx, 404 or 410), and when robots.txt disallows a named AI agent (ClaudeBot, GPTBot,
PerplexityBot and their user-fetch agents) for that page, code `ai_opt_out`. That refuses Mercado Libre, Amazon
México and Rappi (AI opt-out), La Comer (robots.txt disallows the page) and Soriana (robots.txt answers 403). The app shows them as "Not collected" with an official alternative where one exists.

## How the backend uses it

- `/scrapers/match`: `kit.source.for_url(load(), url)`: `available` when a source exists, else `missing`.
- `/scrapers/build`: [backend/server/builds.py](../backend/server/builds.py). Access first (a refusal never starts a
  session), then `kit probe`, then a Devin session told to use the
  [build-source skill](../.agents/skills/build-source/SKILL.md) with
  [devin/output.schema.json](devin/output.schema.json) as its structured output. The backend runs the gate on the
  session's branch; a failure goes back to the same session, up to 3 attempts. The scraper is `available` once the
  gate passes; its PR merges through CI.
- `/scrape`: a page URL goes through `collect_page` (its source's `page`, else `kit.generic.page.read`); a
  first-party catalog goes through `collect`, then `kit.match.matches(product, rows)` picks the scanned product.
  Rows become the app's `Listing` with the backend's `id`, `pageId`, `domain`, `retailerName` and `scrapedAt`.

## Merging

[scraper-kit-merge.yml](../.github/workflows/scraper-kit-merge.yml) squash-merges a PR labelled `kit-source` when
the tests passed on its exact head commit and it only adds or changes one source's file and fixture. Everything
else waits for review. The workflow is off (`if: false`); turning it on also needs the repository to allow Actions to
merge.
