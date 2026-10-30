// Run: npm test  (node --test with native TypeScript stripping; no network, no API calls)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { identityFromOff, IdentifyError, isThinRecord, parseClaudeResponse, parseOffResponse, slugify } from './parse.ts';

const text = (t: string) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: t }] });

const doritosJson = {
  brand: 'Doritos',
  productName: 'Doritos Incógnita',
  variant: 'Incógnita',
  size: '62 g',
  manufacturer: 'Sabritas (PepsiCo México)',
  categoryGuess: 'Botanas > Totopos',
  confidence: 0.91,
  alternatives: [
    { brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', size: '62 g', confidence: 0.2 },
    { brand: '', productName: 'ignored', variant: '', size: '', confidence: 0.1 },
  ],
};

test('photo response → identity', () => {
  const id = parseClaudeResponse(text(JSON.stringify(doritosJson)), { source: 'claude' });
  assert.equal(id.id, 'doritos-incognita-62g', 'no barcode: stable slug of brand + name + size');
  assert.equal(id.productName, 'Doritos Incógnita');
  assert.equal(id.variant, 'Incógnita');
  assert.equal(id.source, 'claude');
  assert.equal(id.confidence, 0.91);
  assert.equal(id.alternatives?.length, 1, 'alternative without brand is dropped');
  assert.equal(id.barcode, undefined);
});

test('barcode context: the id is gtin- + GTIN-14 whatever the name says', () => {
  const a = parseClaudeResponse(text(JSON.stringify(doritosJson)), { source: 'claude', barcode: '7315122013887' });
  const b = parseClaudeResponse(text(JSON.stringify({ ...doritosJson, brand: 'IKEA', productName: 'IKEA Choklad Nöt' })), {
    source: 'claude',
    barcode: '07315122013887',
  });
  assert.equal(a.id, 'gtin-07315122013887');
  assert.equal(b.id, a.id);
  assert.equal(b.barcode, '07315122013887', 'barcode stays as scanned');
});

test('barcode context: barcode, image and confidence cap applied; empty strings become undefined', () => {
  const id = parseClaudeResponse(text(JSON.stringify({ ...doritosJson, variant: '', alternatives: [] })), {
    source: 'claude',
    barcode: '7500000000017',
    imageUrl: 'https://example.test/x.jpg',
    maxConfidence: 0.4,
  });
  assert.equal(id.barcode, '7500000000017');
  assert.equal(id.imageUrl, 'https://example.test/x.jpg');
  assert.equal(id.confidence, 0.4);
  assert.equal(id.variant, undefined);
  assert.equal(id.alternatives, undefined);
});

test('confidence given as percent or garbage is normalized', () => {
  assert.equal(parseClaudeResponse(text(JSON.stringify({ ...doritosJson, confidence: 85 })), { source: 'claude' }).confidence, 0.85);
  assert.equal(parseClaudeResponse(text(JSON.stringify({ ...doritosJson, confidence: 'x' })), { source: 'claude' }).confidence, 0.5);
});

test('no product visible → not_a_product', () => {
  assert.throws(
    () => parseClaudeResponse(text(JSON.stringify({ ...doritosJson, brand: '', productName: '' })), { source: 'claude' }),
    (e: unknown) => e instanceof IdentifyError && e.code === 'not_a_product',
  );
});

test('refusal, max_tokens and invalid JSON are errors', () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof IdentifyError ? e.code : 'other';
    }
    return 'none';
  };
  assert.equal(codeOf(() => parseClaudeResponse({ stop_reason: 'refusal', content: [] }, { source: 'claude' })), 'refusal');
  assert.equal(codeOf(() => parseClaudeResponse({ stop_reason: 'max_tokens', content: [] }, { source: 'claude' })), 'truncated');
  assert.equal(codeOf(() => parseClaudeResponse(text('{"brand": "Dor'), { source: 'claude' })), 'invalid_output');
});

test('Open Food Facts body parsing and fallback identity', () => {
  assert.equal(parseOffResponse({ status: 0, status_verbose: 'product not found' }), undefined);
  const off = parseOffResponse({
    status: 1,
    product: { product_name_es: 'Incógnita', brands: 'Doritos, Sabritas', quantity: '62 g', image_front_url: 'https://img.test/a.jpg', categories: 'Snacks,Botanas,Totopos' },
  });
  assert.ok(off);
  const id = identityFromOff(off, '7500000000017');
  assert.equal(id.productName, 'Doritos Incógnita');
  assert.equal(id.brand, 'Doritos');
  assert.equal(id.source, 'openfoodfacts');
  assert.equal(id.id, 'doritos-incognita-62g', 'fictional barcode (bad check digit) → slug');
  assert.equal(identityFromOff(off, '7501011123588').id, 'gtin-07501011123588', 'valid barcode → gtin- id');
  assert.equal(id.categoryGuess, 'Botanas > Totopos');
  assert.equal(id.imageUrl, 'https://img.test/a.jpg');
});

test('slugify strips accents and punctuation', () => {
  assert.equal(slugify("Doritos Flamin' Hot", '62 g'), 'doritos-flamin-hot-62-g');
  assert.equal(slugify(''), 'product');
});

test('web search turn: text before the last search is ignored; JSON inside prose is recovered', () => {
  const answer = JSON.stringify({ ...doritosJson, brand: 'IKEA', productName: 'IKEA CHOKLAD NÖT', alternatives: [] });
  const turn = {
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: "I'll search for this barcode {not json}." },
      { type: 'server_tool_use' },
      { type: 'web_search_tool_result' },
      { type: 'text', text: `It is an IKEA bar.\n\`\`\`json\n${answer}\n\`\`\`` },
    ],
  };
  const id = parseClaudeResponse(turn, { source: 'claude', barcode: '7315122013887' });
  assert.equal(id.brand, 'IKEA');
  assert.equal(id.productName, 'IKEA CHOKLAD NÖT');
  assert.throws(
    () => parseClaudeResponse({ stop_reason: 'pause_turn', content: [] }, { source: 'claude' }),
    (e: unknown) => e instanceof IdentifyError && e.code === 'truncated',
  );
});

test('a record without a brand is thin', () => {
  assert.equal(isThinRecord(undefined), true);
  assert.equal(isThinRecord({ code: '7315122013887', product_name: 'choklad not' }), true);
  assert.equal(isThinRecord({ product_name: 'Incógnita', brands: 'Doritos' }), false);
});

test('alternatives that repeat the answer or each other are dropped', () => {
  const id = parseClaudeResponse(
    text(
      JSON.stringify({
        ...doritosJson,
        alternatives: [
          { brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', size: '62 g', confidence: 0.2 },
          { brand: 'Doritos', productName: 'DORITOS INCÓGNITA', variant: '', size: '62g', confidence: 0.1 },
          { brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', size: '145 g', confidence: 0.1 },
          { brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', size: '145 gr', confidence: 0.05 },
        ],
      }),
    ),
    { source: 'claude' },
  );
  assert.deepEqual(id.alternatives?.map((a) => a.size), ['145 g']);
});
