### Round 2: before and after, 48 products

Run `baseline` (the pipeline before tuning) → run `final` (the app's defaults). Latency is end to end: OFF lookups, every Claude call and the photo step, replayed from recorded timings.

| Path | Before: all fields | Before: p50 / p90 | After: all fields | After: p50 / p90 | Cost / scan |
|---|---|---|---|---|---|
| Barcode, full OFF record (42) | 35/42 (83%) | 3.3 s / 3.9 s | 35/42 (83%) | **2.1 s / 2.7 s** | $0.008 → $0.0005 |
| Barcode, thin or no OFF record (6) | 4/6 | 3.8–14.5 s / 31.3 s | 4/6 | 3.8–14.9 s / **15.1 s** | $0.05–0.14 → $0.04–0.10 |
| Barcode with OFF hidden, web search (C, 10) | 6/10 | 16.2 s / 21.5 s | 7/10 and 6/10 (two effort-low runs) | **12.9 s / 13.8–15.5 s** | $0.14 → $0.10 |
| Photo of the front (D, 47) | 41/47 (87%) | 3.9 s / 6.8 s | 40/47 (85%) | 4.5 s / 7.0 s | $0.013 → $0.015 |
| Photo showing the barcode (E, 10) | 6/10 | 5.6 s / 6.7 s | **9/10** (8–10 over three runs) | 8.1 s / 10.9 s | $0.014 → $0.018 |

Each product ran once per configuration. A rerun differs by a product or two, and API latency drifts by about 0.5 s between runs. D's change (one product fewer, 0.6 s slower) is within that. The `photo-barcode` run, which only added the barcode question, had the same D p50 as the baseline (3.9 s).

**Kept: Haiku 5.5 normalizes a complete OFF record** (brand, name and quantity) and does the photo + barcode reconcile.
- On the 44 products with a brand in OFF, Haiku was as accurate as Opus (36/44 each), with one more confident-wrong answer (5 vs 4).
- It was 1.5 s faster at p50 (2.1 s vs 3.6 s) and cost a tenth as much.
- The two differ on two products. Haiku keeps Lala's legal name; Opus drops "Kellogg's" from Zucaritas.
- Sonnet 5.5 matched Opus on the first 25 products (21/25) at 2.9 s.

**Kept: web search at effort low** (thin or no record). On arm C, Opus at effort low cut p50 from 16.2 s to 12.9 s and cost from $0.14 to $0.10. Accuracy held: 7/10 and 6/10 against 6/10.
- **Dropped: Sonnet at effort low.** It was faster (11.6 s) but got only 4/10: Hot Nuts became "Multintenso", and the Gansito size was lost.

**Kept: reading barcodes in photos.** Vision also copies the digits under a visible barcode.
- A valid GS1 code is looked up in OFF, and a complete record is reconciled with the photo in one Haiku call.
- The barcode becomes the identity's `gtin-` id. Confidence rises to 0.9 when the photo and the record name the same brand.
- A photo of only a barcode goes down the barcode path.
- Barcode-side photos went from 6/10 to 8–10/10. Lala 100, Bimbo Pan Tostado and IKEA CHOKLAD LJUS are now right; before, vision guessed them from the back of the pack.
- This adds about 2.5 s to those photos only. No front photo in the set triggered it.

**Kept: distinct alternatives and calibrated web confidence.**
- The prompt asks for each alternative to be another flavor, variant or size, with both filled in.
- `parseIdentity` drops repeats (same brand + name + variant + size slug).
- Confirm puts the flavor in the row title ("IKEA Choklad · Milk chocolate").
- Web search says ≥ 0.9 when a brand's or store's page shows the exact barcode.
- None of this moves the scored fields. Confident-wrong on the barcode path stayed at 6/48.

**Dropped: trying other spellings of the barcode in OFF.** OFF already maps `049000028911`, `0049000028911` and `07501011123588` to their records. The check-digit code (`gtin.ts`) is used for ids and for trusting barcodes read off photos.

**Dropped: OFF without Claude.** Arm A takes 0.6 s but gets 33/48 (69%), against 39/48 for the barcode path.

**Reverted: a shorter productName prompt.** It fixed Zucaritas but broke two front photos: "Maseca" without "Harina de Maíz", and Carnation.

**Product ids:** `gtin-` + GTIN-14 whenever there is a valid barcode, whether scanned, typed or read off a photo. Otherwise a stable brand + name + size slug.

**Still failing:**
- OFF data errors that the barcode path copies (Doritos 61 g, Maseca 200 g, Aurrera without "Reducida en grasa", Hershey's generic name). The photo gets these right.
- Sizes not in the frame (Coca-Cola 3 L, the 235 ml can).
- Pinol 1.65 L, where web search finds the line but not the size.

Spend for round 2: $10.38 of fresh calls, every experiment included. Round 1's notes follow.

### Round 1 headline (25 products, effort low barcode / medium photo)

| | All fields right | Confident & wrong | Median latency | Cost per scan |
|---|---|---|---|---|
| A. OFF only | 19/25 (76%) | 0 (confidence is always 0.70) | 0.4 s | free |
| B. OFF + Claude | 21/25 (84%) | 3 | 2.6 s + OFF lookup | $0.008 |
| C. Barcode only | 0/25 (0%) | 0 | 3.5 s | $0.010 |
| D. Photo | 20/24 (83%) | 1 | 3.0 s | $0.012 |

All 75 Claude calls, the 3 smoke-test calls included (reused from cache), cost **$0.76**. That is well under the $5 cap. There were no API errors, refusals or fallbacks to another model.

### OFF + Claude vs OFF only (B vs A)

**Claude is better than OFF alone, but it can't fix wrong data.** B fixes the two failures that come from how `identityFromOff` reads the record:
- La Costeña: brand "CONSERVAS LA COSTEÑA S.A. DE C.V." becomes "La Costeña".
- Lala: the full legal description becomes "Lala Leche Entera".

B's names are also cleaner throughout, with proper capitalization and a variant split out. That is what the retailer search will query with.

All four of B's misses are copied from the OFF record:
- Doritos 61 g instead of 62 g;
- Maseca 200 g instead of 1 kg;
- Ibarra's descriptive name;
- La Moderna's missing "Integral" (the key is uncertain here).

B's confidence doesn't warn about them: it was 0.85 on the wrong Doritos size. Overall, B's mean confidence is 0.85 on right answers and 0.80 on wrong ones. B says ≥ 0.8 on 24 of 25 products, and 3 of those are wrong.

The extra cost is under a cent and about 2.6 s per scan. **Keep B as the barcode path.**

### Photo path (D)

**The photo path is reliable enough to use.** It got 20 of 24 readable photos right, and 5 of the 7 smaller brands, the best of any arm.
- **Its confidence is useful.** Mean confidence was 0.84 on right answers and 0.53 on wrong ones. 14 of its 15 answers at ≥ 0.8 were right.
- **It drops confidence when it can't read something:**
  - Fritos and Tostitos, with no size visible: 0.6 and 0.5.
  - Peñafiel's special-edition label: 0.5.
  - Herdez, a can with no label: it guessed "Tuny Atún" at 0.15.
- **It fixes OFF's errors.** It read 62 g on the Doritos bag, 1 kg on the Maseca bag, "Integral" on La Moderna and "Choco Choco" on Ibarra.
- **Its only confident miss is a near miss.** Ibarra came back as brand "Choco Choco", name "Choco Choco Instantáneo" (0.90): it missed the small Ibarra logo.
- **Its typical weakness is size,** when the net content isn't in the frame.
- **Barcode and photo complement each other:** B's misses are OFF data errors that the photo gets right, and D's misses are sizes that OFF has.

### Barcode-only fallback (C)

**Block it: never show a barcode-only guess as an identification.** C got 0 of 25 right:
- 13 times it returned no product. The app turns that into a `not_a_product` error, which reads "Could not find a product in this input".
- The other 12 were wrong guesses. Doritos came back as "Sabritas Original", Hot Nuts as "Takis Fuego", and La Costeña frijoles as "Chiles Jalapeños en Rajas".
- It did get the maker right from the barcode prefix about half the time (11/25 brands).
- It was never confident. Claude's highest raw confidence was 0.45, so the app's 0.4 cap never mattered, and nothing was confidently wrong.

Instead, when OFF has no record, the app should say the product wasn't found and go straight to "take a photo". Showing a "Sabritas Original" guess, even with "Check this", invites the user to confirm a wrong product. At most, keep the brand as a hint.

### Recommendation for the app
1. **Barcode → OFF + Claude (B), as built.** It's the best barcode result, and cheap.
2. **The photo path (D) is ready to use.** Show its confidence: under 0.8 means "check this", and that held up in this test.
3. **No OFF record:** go to the photo flow instead of showing Claude's barcode-only guess.
4. **Worth trying next (not tested):** send the photo together with the OFF record when both exist. B's misses are exactly what D reads correctly, and the call would cost about $0.012.
5. **`identityFromOff`** (only used when Claude fails): skip legal entity names like "… S.A. de C.V." when picking the brand.

### Caveats
- 25 products, all of which have an OFF record with a photo. Real coverage of smaller brands will be lower.
- The key was drafted from OFF, which favours arms A and B wherever OFF is right.
- The photos are crowd-sourced OFF front shots, not photos taken in the app.
- Each product was run once, so a different run could differ by a product or two.
