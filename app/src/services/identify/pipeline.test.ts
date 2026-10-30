// Run: npm test  (node --test; fake Open Food Facts and Claude, no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProductIdentity } from '@/api/types';

import type { OffProduct } from './parse.ts';
import { DEFAULT_OPTIONS, identifyBarcode, identifyPhoto, isCompleteRecord, mergePhotoBarcode, sameBrand, type IdentifyDeps } from './pipeline.ts';
import type { MessageBody, MessageLike } from './requests.ts';

const answer = (o: Record<string, unknown>): MessageLike => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ manufacturer: '', categoryGuess: '', alternatives: [], variant: '', size: '', ...o }) }],
});

const doritosOff: OffProduct = { code: '7501011123588', product_name: 'doritos nacho', brands: 'Doritos', quantity: '61 gr', image_front_url: 'https://off/doritos.jpg' };

function fakeDeps(off: Record<string, OffProduct>, replies: ((body: MessageBody) => MessageLike)[]) {
  const bodies: MessageBody[] = [];
  const lookups: string[] = [];
  const deps: IdentifyDeps = {
    lookupOff: async (code) => {
      lookups.push(code);
      return off[code];
    },
    transport: async (body) => {
      bodies.push(body);
      const reply = replies.shift();
      if (!reply) throw new Error('unexpected Claude call');
      return reply(body);
    },
  };
  return { deps, bodies, lookups };
}

const seen = (o: Partial<ProductIdentity>): ProductIdentity => ({
  id: 'x',
  brand: 'Doritos',
  productName: 'Doritos Nacho',
  confidence: 0.6,
  source: 'claude',
  ...o,
});

test('complete record: one call on the fast normalize model, gtin- id', async () => {
  const { deps, bodies } = fakeDeps({ '7501011123588': doritosOff }, [() => answer({ brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', size: '62 g', confidence: 0.9 })]);
  const id = await identifyBarcode('7501011123588', deps, DEFAULT_OPTIONS);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, DEFAULT_OPTIONS.normalizeModel);
  assert.equal(bodies[0].tools, undefined, 'no web search for a complete record');
  assert.equal(bodies[0].fallbacks, undefined, 'Haiku has no server-side refusal fallback');
  assert.equal(id.id, 'gtin-07501011123588');
  assert.equal(id.imageUrl, 'https://off/doritos.jpg');
});

test('no record: web search on the main model at the configured effort', async () => {
  const { deps, bodies } = fakeDeps({}, [() => answer({ brand: 'Pinol', productName: 'Pinol Limpiador Repelente', size: '1 L', confidence: 0.9 })]);
  const id = await identifyBarcode('7501025411138', deps, DEFAULT_OPTIONS);
  assert.equal(bodies[0].model, 'claude-opus-5-5');
  assert.equal((bodies[0].tools?.[0] as { type: string }).type, 'web_search_20260209');
  assert.equal(bodies[0].output_config.effort, DEFAULT_OPTIONS.webEffort);
  assert.equal(id.id, 'gtin-07501025411138');
});

test('Claude fails on a full record: falls back to the OFF identity', async () => {
  const { deps } = fakeDeps({ '7501011123588': doritosOff }, [() => ({ stop_reason: 'refusal', content: [] })]);
  const id = await identifyBarcode('7501011123588', deps, DEFAULT_OPTIONS);
  assert.equal(id.source, 'openfoodfacts');
  assert.equal(id.id, 'gtin-07501011123588');
});

test('complete vs thin records', () => {
  assert.equal(isCompleteRecord(doritosOff), true);
  assert.equal(isCompleteRecord({ ...doritosOff, quantity: '' }), false);
  assert.equal(isCompleteRecord({ ...doritosOff, brands: '' }), false);
  assert.equal(isCompleteRecord(undefined), false);
});

test('same brand: in OFF brands or name, accents and case ignored', () => {
  assert.equal(sameBrand({ brand: 'Doritos', productName: '' }, doritosOff), true);
  assert.equal(sameBrand({ brand: 'Kellogg’s', productName: '' }, { product_name: 'Zucaritas', brands: "Kellogg's" }), true);
  assert.equal(sameBrand({ brand: 'Takis', productName: '' }, doritosOff), false);
});

test('photo barcode merge: same brand → barcode, gtin- id, OFF photo, missing size, confidence 0.9', () => {
  const m = mergePhotoBarcode(seen({}), '7501011123588', doritosOff);
  assert.equal(m.barcode, '7501011123588');
  assert.equal(m.id, 'gtin-07501011123588');
  assert.equal(m.size, '61 gr');
  assert.equal(m.imageUrl, 'https://off/doritos.jpg');
  assert.equal(m.confidence, 0.9);
  assert.equal(mergePhotoBarcode(seen({ size: '62 g' }), '7501011123588', doritosOff).size, '62 g', 'the photo’s size wins');
});

test('photo barcode merge: bad check digit or a confident other brand → unchanged; no record → barcode only', () => {
  const s = seen({});
  assert.equal(mergePhotoBarcode(s, '7501011123587', doritosOff), s);
  const takis = seen({ brand: 'Takis', productName: 'Takis Fuego', confidence: 0.95 });
  assert.equal(mergePhotoBarcode(takis, '7501011123588', doritosOff), takis);
  const noRecord = mergePhotoBarcode(s, '7501011123588', undefined);
  assert.equal(noRecord.barcode, '7501011123588');
  assert.equal(noRecord.confidence, 0.6, 'no cross-check, no boost');
});

test('photo showing a barcode: digits read, OFF looked up, record and photo reconciled', async () => {
  const { deps, bodies, lookups } = fakeDeps({ '7501000111800': { product_name: 'Pan Tostado Clásico', brands: 'Bimbo', quantity: '210 g' } }, [
    () => answer({ brand: 'Bimbo', productName: 'Pan Blanco Bimbo', size: '680 g', confidence: 0.5, barcodeDigits: '7501000111800' }),
    (body) => {
      const text = JSON.stringify(body.messages);
      assert.match(text, /Pan Tostado/, 'the record goes to the reconcile call');
      assert.match(text, /Pan Blanco Bimbo/, 'and so does the photo reading');
      return answer({ brand: 'Bimbo', productName: 'Bimbo Pan Tostado Clásico', size: '210 g', confidence: 0.85 });
    },
  ]);
  const id = await identifyPhoto({ base64: 'x', mimeType: 'image/jpeg' }, deps, DEFAULT_OPTIONS);
  assert.deepEqual(lookups, ['7501000111800']);
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[0].output_config.format), /barcodeDigits/);
  assert.equal(id.productName, 'Bimbo Pan Tostado Clásico');
  assert.equal(id.size, '210 g');
  assert.equal(id.id, 'gtin-07501000111800');
  assert.equal(id.confidence, 0.9, 'photo and record agree on the brand');
});

test('photo of only a barcode: no product named, digits read → barcode path', async () => {
  const off = { '1005247440007': { product_name: 'choklad ljus', brands: 'IKEA', quantity: '100 g' } };
  const { deps, bodies } = fakeDeps(off, [
    () => answer({ brand: '', productName: '', confidence: 0, barcodeDigits: '1005247440007' }),
    () => answer({ brand: 'IKEA', productName: 'IKEA Choklad Ljus', variant: 'Milk chocolate', size: '100 g', confidence: 0.85 }),
  ]);
  const id = await identifyPhoto({ base64: 'x', mimeType: 'image/jpeg' }, deps, DEFAULT_OPTIONS);
  assert.equal(bodies.length, 2);
  assert.equal(id.productName, 'IKEA Choklad Ljus');
  assert.equal(id.id, 'gtin-01005247440007');
});

test('photo without a barcode: one vision call, no lookup', async () => {
  const { deps, bodies, lookups } = fakeDeps({}, [() => answer({ brand: 'Doritos', productName: 'Doritos Nacho', size: '62 g', confidence: 0.9, barcodeDigits: '' })]);
  const id = await identifyPhoto({ base64: 'x', mimeType: 'image/jpeg' }, deps, DEFAULT_OPTIONS);
  assert.equal(bodies.length, 1);
  assert.deepEqual(lookups, []);
  assert.equal(id.id, 'doritos-nacho-62g');
});
