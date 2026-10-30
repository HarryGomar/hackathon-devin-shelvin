/**
 * Adds hand-researched products to testset.json and answers.json:  npm run add-products -- <file.json>
 *
 * Each entry: { barcode, tier, aisle, brand, brandAliases?, productName, nameAliases?, variant, variantOptional?, size,
 * sizeAliases?, tricky?, frontImageUrl?, barcodeImageUrl?, sources?, checkNote }. The OFF record is fetched (cached)
 * exactly as the app would see it, and offStatus is worked out from it. Existing barcodes are replaced.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { isThinRecord } from '../../../app/src/services/identify/parse.ts';
import { isValidGtin } from '../../../app/src/services/identify/gtin.ts';
import { fetchImage, fullSizeImageUrl, lookupOff } from './off.ts';
import { ANSWERS_FILE, TESTSET_FILE } from './paths.ts';
import type { Answer, TestItem } from './types.ts';

interface Entry extends Omit<Answer, 'photo' | 'checkNote'> {
  tier: TestItem['tier'];
  aisle: string;
  tricky?: string[];
  frontImageUrl?: string | null;
  barcodeImageUrl?: string | null;
  sources?: string[];
  checkNote: string;
  photo?: Answer['photo'];
}

const file = process.argv[2];
if (!file) throw new Error('usage: npm run add-products -- <file.json>');
const entries = JSON.parse(readFileSync(file, 'utf8')) as Entry[];
const items = JSON.parse(readFileSync(TESTSET_FILE, 'utf8')) as TestItem[];
const answers = JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) as Answer[];

const full = (url: string | null | undefined) => (url ? (url.includes('images.openfoodfacts.org') ? fullSizeImageUrl(url) : url) : undefined);

for (const e of entries) {
  if (!isValidGtin(e.barcode)) throw new Error(`${e.barcode}: check digit is wrong`);
  const { product, latencyMs } = await lookupOff(e.barcode);
  const offStatus: TestItem['offStatus'] = !product ? 'none' : isThinRecord(product) || !product.quantity?.trim() ? 'thin' : 'full';
  const imageFullUrl = full(e.frontImageUrl);
  const barcodeImageUrl = full(e.barcodeImageUrl);
  // Fail now rather than mid-benchmark if an image is gone.
  if (imageFullUrl) await fetchImage(`${e.barcode}.D`, imageFullUrl);
  if (barcodeImageUrl) await fetchImage(`${e.barcode}.E`, barcodeImageUrl);
  const item: TestItem = {
    barcode: e.barcode,
    tier: e.tier,
    aisle: e.aisle,
    off: product,
    offStatus,
    tricky: e.tricky?.length ? e.tricky : undefined,
    offLatencyMs: latencyMs,
    imageUrl: e.frontImageUrl ?? undefined,
    imageFullUrl,
    barcodeImageUrl,
  };
  const answer: Answer = {
    barcode: e.barcode,
    brand: e.brand,
    brandAliases: e.brandAliases?.length ? e.brandAliases : undefined,
    productName: e.productName,
    nameAliases: e.nameAliases?.length ? e.nameAliases : undefined,
    variant: e.variant,
    variantOptional: e.variantOptional || undefined,
    size: e.size,
    sizeAliases: e.sizeAliases?.length ? e.sizeAliases : undefined,
    photo: e.photo ?? 'good',
    checkNote: `${e.checkNote}${e.sources?.length ? ` Sources: ${e.sources.join(' ')}` : ''}`,
    uncertain: e.uncertain || undefined,
  };
  const i = items.findIndex((x) => x.barcode === e.barcode);
  if (i >= 0) items[i] = item;
  else items.push(item);
  const j = answers.findIndex((x) => x.barcode === e.barcode);
  if (j >= 0) answers[j] = answer;
  else answers.push(answer);
  console.log(`${e.barcode} ${offStatus.padEnd(4)} ${e.productName} ${e.size}${barcodeImageUrl ? ' (+barcode photo)' : ''}`);
}

writeFileSync(TESTSET_FILE, JSON.stringify(items, null, 2) + '\n');
writeFileSync(ANSWERS_FILE, JSON.stringify(answers, null, 2) + '\n');
console.log(`${items.length} products in testset.json`);
