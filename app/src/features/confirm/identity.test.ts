// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProductIdentity } from '@/api/types';

import { alternativeLabel, draftFrom, identityFromAlternative, identityFromDraft, inputBarcode, isDraftValid, productConfidence, splitAlternatives } from './identity';

const doritos: ProductIdentity = {
  id: 'doritos-incognita',
  brand: 'Doritos',
  productName: 'Doritos Incógnita',
  variant: 'Incógnita',
  size: '62 g',
  barcode: '7500000000017',
  manufacturer: 'Sabritas',
  imageUrl: 'https://example.com/doritos.png',
  confidence: 0.95,
  source: 'mock',
  alternatives: [
    { brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', size: '145 g', confidence: 0.4 },
    { brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', size: '70 g', confidence: 0.1 },
  ],
};

test('input barcode only for barcode inputs', () => {
  assert.equal(inputBarcode({ kind: 'barcode', code: '7500000000017' }), '7500000000017');
  assert.equal(inputBarcode({ kind: 'photo', uri: 'file:///x.jpg', base64: '' } as never), undefined);
  assert.equal(inputBarcode(undefined), undefined);
});

test('alternative without a valid barcode: another size gets its own id; previous guess swaps into the list', () => {
  const alt = doritos.alternatives![0];
  const picked = identityFromAlternative(doritos, alt, { kind: 'barcode', code: '7500000000017' });
  assert.notEqual(picked.id, doritos.id);
  assert.equal(picked.id, 'doritos-incognita-145g');
  assert.equal(picked.size, '145 g');
  assert.equal(picked.source, 'user_edited');
  assert.equal(picked.confidence, 1);
  assert.equal(picked.manufacturer, 'Sabritas', 'same brand keeps the manufacturer');
  assert.equal(picked.alternatives?.[0].size, '62 g');
  assert.equal(picked.alternatives?.[1].brand, 'Takis');
});

test('alternative with a scanned barcode keeps the gtin- id (same product in hand)', () => {
  const scanned = { ...doritos, id: 'gtin-07501011123588', barcode: '7501011123588' };
  const picked = identityFromAlternative(scanned, scanned.alternatives![0], { kind: 'barcode', code: '7501011123588' });
  assert.equal(picked.id, 'gtin-07501011123588');
  assert.equal(picked.size, '145 g');
});

test('alternative: another brand drops the manufacturer', () => {
  const picked = identityFromAlternative(doritos, doritos.alternatives![1]);
  assert.equal(picked.id, 'takis-fuego-70g');
  assert.equal(picked.manufacturer, undefined);
  assert.equal(picked.barcode, undefined);
});

test('draft: round-trips, trims, and keeps the image only for the same product', () => {
  const draft = draftFrom(doritos);
  assert.equal(isDraftValid(draft), true);
  const sameProduct = identityFromDraft({ ...draft, variant: ' Incógnita ' }, doritos);
  assert.equal(sameProduct.id, 'doritos-incognita-62g', 'fictional barcode → slug');
  assert.equal(sameProduct.variant, 'Incógnita');
  assert.equal(sameProduct.source, 'user_edited');

  const other = identityFromDraft({ ...draft, brand: 'Takis', productName: 'Takis Fuego', variant: '' }, doritos);
  assert.equal(other.id, 'takis-fuego-62g');
  assert.equal(other.imageUrl, undefined);
  assert.equal(other.variant, undefined, 'empty field becomes undefined');
  assert.equal(other.alternatives?.length, 2);
});

test('draft: an edit keeps the id while the barcode is unchanged', () => {
  const scanned: ProductIdentity = { ...doritos, id: 'gtin-07501011123588', barcode: '7501011123588' };
  const edited = identityFromDraft({ ...draftFrom(scanned), productName: 'Doritos Incógnita Picante', size: '145 g' }, scanned);
  assert.equal(edited.id, 'gtin-07501011123588');
  assert.equal(edited.imageUrl, scanned.imageUrl, 'same product keeps its photo');
  const padded = identityFromDraft({ ...draftFrom(scanned), barcode: '07501011123588' }, scanned);
  assert.equal(padded.id, 'gtin-07501011123588', 'same GTIN written differently');
  const other = identityFromDraft({ ...draftFrom(scanned), barcode: '7501011127012' }, scanned);
  assert.equal(other.id, 'gtin-07501011127012', 'new barcode → its own id');
  assert.equal(other.imageUrl, undefined);
  const cleared = identityFromDraft({ ...draftFrom(scanned), barcode: '' }, scanned);
  assert.equal(cleared.id, 'doritos-incognita-62g', 'barcode removed → slug');
});

test('draft: brand and product name are required', () => {
  assert.equal(isDraftValid({ ...draftFrom(), brand: 'Doritos' }), false);
  assert.equal(isDraftValid({ ...draftFrom(), brand: ' ', productName: 'x' }), false);
  assert.equal(draftFrom(undefined, { kind: 'manual', code: '7500000000024' }).barcode, '7500000000024');
});

test('alternative label: the flavor shows in the title unless the name already says it', () => {
  const milk = alternativeLabel({ brand: 'IKEA', productName: 'IKEA Choklad', variant: 'Milk chocolate', size: '100 g', confidence: 0.15 });
  const dark = alternativeLabel({ brand: 'IKEA', productName: 'IKEA Choklad', variant: 'Dark chocolate', size: '100 g', confidence: 0.1 });
  assert.equal(milk.title, 'IKEA Choklad · Milk chocolate');
  assert.notEqual(milk.title, dark.title, 'same line, different flavor: rows differ');
  assert.equal(milk.subtitle, '100 g', 'brand already in the name');
  const takis = alternativeLabel({ brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', size: '70 g', confidence: 0.1 });
  assert.equal(takis.title, 'Takis Fuego');
  const gansito = alternativeLabel({ brand: 'Marinela', productName: 'Gansito', size: '50 g', confidence: 0.1 });
  assert.equal(gansito.subtitle, 'Marinela · 50 g');
});

// A photo of Doritos Dinamita Chile Limón: Claude split its confidence across sizes of the same bag.
const dinamita: ProductIdentity = {
  id: 'doritos-dinamita',
  brand: 'Doritos',
  productName: 'Doritos Dinamita Chile Limón',
  variant: 'Chile Limón',
  size: '92.1 g',
  confidence: 0.55,
  source: 'claude',
  alternatives: [
    { brand: 'Doritos', productName: 'Doritos Dinamita Chile Limón', variant: 'Chile Limón', size: '304.7 g', confidence: 0.25 },
    { brand: 'Doritos', productName: 'Doritos Dinamita Chile Limón', variant: 'Chile Limón (Sabritas México)', size: '65 g', confidence: 0.1 },
    { brand: 'Doritos', productName: "Doritos Dinamita Flamin' Hot", variant: "Flamin' Hot", size: '92.1 g', confidence: 0.03 },
  ],
};

test('other sizes of the answer go to the size picker; other flavors stay in "Not quite?"', () => {
  const { sizes, others } = splitAlternatives(dinamita);
  assert.deepEqual(sizes.map((a) => a.size), ['304.7 g', '65 g']);
  assert.deepEqual(others.map((a) => a.productName), ["Doritos Dinamita Flamin' Hot"]);
});

test('product confidence adds the other sizes of the answer, not other products', () => {
  assert.equal(Math.round(productConfidence(dinamita) * 100), 90);
  assert.equal(productConfidence(doritos), 1); // 0.95 + 0.4 for 145 g, capped
  const noSizes = { ...dinamita, alternatives: dinamita.alternatives!.slice(3) };
  assert.equal(productConfidence(noSizes), 0.55);
});
