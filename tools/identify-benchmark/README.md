# identify-benchmark

Measures how well the app identifies real Mexican products (`app/src/services/identify/`) and writes [`results/REPORT.md`](results/REPORT.md).

The test set has 48 products sold in Mexico. 25 have a full Open Food Facts (OFF) record. The other 23 cover the hard cases: thin or missing OFF records, several sizes or flavors of one line, UPC-A codes, store brands and IKEA food. 10 of them also have a photo that shows the barcode.

Every arm runs the app's own pipeline (`app/src/services/identify/pipeline.ts`: `identifyBarcode` / `identifyPhoto`) with the app's request bodies (`requests.ts`). Only the I/O is swapped. OFF records, Claude responses and photo-step results are cached on disk and replayed after waiting their original latency. Reruns are free, and latency is what the user waits from scan to Confirm.

| Arm | What it runs |
|---|---|
| A | OFF only (`identityFromOff`) |
| B | Barcode: OFF → Claude normalize (Haiku for a complete record); web search when the record has no brand or is missing |
| C | Barcode with the OFF record hidden (the app web-searches the barcode); first `--c-limit` products |
| D | Photo of the front |
| E | Photo that shows the barcode (vision reads the digits; OFF cross-check) |

```bash
npm install
npm run bench -- --tag mytry --arms A,B,D,E                     # a run with the app's DEFAULT_OPTIONS; stops at --max-cost (default $2)
npm run bench -- --tag t --options '{"normalizeModel":"claude-sonnet-5-5"}'   # try an IdentifyOptions override
npm run bench -- --tag t --arms B --skip-web                    # skip products whose barcode path web-searches (the priciest)
npm run compare                                                 # every run: all-fields, confident-wrong, p50/p90, cost per scan
npm run diff -- baseline final B                                # products whose result changed between two runs
npm run report -- --tag final                                   # rewrite results/REPORT.md from a run
npm run add-products -- sources/added-products.json             # add hand-researched products to testset/answers
npm test && npm run typecheck
```

- **Key:** `ANTHROPIC_API_KEY`, else `EXPO_PUBLIC_ANTHROPIC_API_KEY` from `app/.env` (this checkout's, then the main checkout's). It is never printed. Every fresh call's cost is added to `cache/spend.json`.
- **Other options:** `--only <barcodes>`, `--limit 5`, `--fresh` (ignore the cache), `--concurrency 6`. Runs with the same `--tag` merge, so you can add arms or products to a run later.
- **Files:**
  - `testset.json`: the OFF records, `offStatus`, photo URLs.
  - `answers.json`: the hand-checked key. `checkNote` says what was verified or corrected.
  - `sources/added-products.json`: the research behind the 23 added products (retailer URLs, notes).
  - `results/runs/<tag>.json`: one file per configuration tried. `baseline` is the pipeline before tuning; `final` is the app's defaults.
  - `analysis.md`: hand-written conclusions, embedded in the report.
  - `cache/` (gitignored): OFF responses, photos, Claude responses and photo-step results.
