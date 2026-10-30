// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { domainOf, fieldRows, formatFieldValue, formatPrice, htmlToText, humanizeKey, isIdentifierKey, taxonomyNote } from './format';
import { strings } from './strings';

test('humanizeKey: snake_case, camelCase, kebab and acronyms', () => {
  assert.equal(humanizeKey('net_weight'), 'Net weight');
  assert.equal(humanizeKey('reviewCount'), 'Review count');
  assert.equal(humanizeKey('pack-size'), 'Pack size');
  assert.equal(humanizeKey('sku'), 'SKU');
  assert.equal(humanizeKey('GTIN'), 'GTIN');
});

test('identifier keys', () => {
  for (const k of ['sku', 'gtin', 'ean', 'upc', 'barcode', 'code', 'id', 'ID', 'product_id', 'retailerId', 'store-code', 'itemCode'])
    assert.equal(isIdentifierKey(k), true, k);
  for (const k of ['valid', 'paid', 'stock', 'rating', 'unicode', 'net_weight']) assert.equal(isIdentifierKey(k), false, k);
});

test('field values: identifiers and long integers are not grouped', () => {
  assert.equal(formatFieldValue('gtin', 7501011115606), '7501011115606');
  assert.equal(formatFieldValue('sku', 1234), '1234');
  assert.equal(formatFieldValue('product_id', 98765), '98765');
  assert.equal(formatFieldValue('anything', 75010111), '75010111', '8 digits');
});

test('field values: quantities, booleans and empties', () => {
  assert.equal(formatFieldValue('stock', 1234), '1,234');
  assert.equal(formatFieldValue('rating', 4.5), '4.5');
  assert.equal(formatFieldValue('in_stock', true), strings.yes);
  assert.equal(formatFieldValue('in_stock', false), strings.no);
  assert.equal(formatFieldValue('note', null), strings.empty);
  assert.equal(formatFieldValue('note', ''), strings.empty);
  assert.equal(formatFieldValue('brand', 'Doritos'), 'Doritos');
});

test('price in es-MX, with a fallback for unknown currencies', () => {
  assert.match(formatPrice(25.5, 'MXN'), /\$\s?25\.50/);
  assert.equal(formatPrice(1250, 'XXXX'), '1,250 XXXX');
});

test('domainOf', () => {
  assert.equal(domainOf('https://www.walmart.com.mx/ip/1'), 'walmart.com.mx');
  assert.equal(domainOf('not a url'), undefined);
});

test('fieldRows: every field, labelled and formatted, in API order', () => {
  assert.deepEqual(fieldRows({ net_weight: '62 g', sku: 7501011115026, in_stock: true, rating: null }), [
    { key: 'net_weight', label: 'Net weight', value: '62 g' },
    { key: 'sku', label: 'SKU', value: '7501011115026' },
    { key: 'in_stock', label: 'In stock', value: strings.yes },
    { key: 'rating', label: 'Rating', value: strings.empty },
  ]);
  assert.deepEqual(fieldRows(undefined), []);
});

test('taxonomyNote: system and code when present', () => {
  assert.equal(taxonomyNote({ system: 'GS1 GPC', path: ['Food'], code: '10000045' }), 'GS1 GPC · Code 10000045');
  assert.equal(taxonomyNote({ system: 'GS1 GPC', path: ['Food'] }), 'GS1 GPC');
  assert.equal(taxonomyNote(undefined), '');
});

test('htmlToText: a description field as plain text, list items as bullets, entities decoded', () => {
  const walmart = '<ul><li>Porque en esos momentos cuando se nos antoja una botanita</li><li>Takis Fuego de 56&nbsp;g</li></ul>';
  assert.equal(htmlToText(walmart), '• Porque en esos momentos cuando se nos antoja una botanita\n• Takis Fuego de 56 g');
  assert.equal(htmlToText('<p>Picante &amp; lim&oacute;n</p><p>Sin gluten<br/>Hecho en M&#233;xico</p>'), 'Picante & limón\nSin gluten\nHecho en México');
  assert.equal(formatFieldValue('description', walmart), htmlToText(walmart));
  assert.equal(formatFieldValue('note', '5 < 7 & plain text stays'), '5 < 7 & plain text stays', 'no tag or entity: unchanged');
  assert.equal(htmlToText('Bad &#99999999; and &unknown; kept'), 'Bad &#99999999; and &unknown; kept');
});

test('htmlToText: scripts, styles and comments go with their contents; an unclosed one hides the rest', () => {
  assert.equal(htmlToText('<p>Hola</p><script>alert(1)</script><style>p{color:red}</style>'), 'Hola');
  assert.equal(htmlToText('<p>Uno</p><!-- nota --><SCRIPT type="x">a()</SCRIPT ><noscript>sin js</noscript><p>Dos</p>'), 'Uno\nDos');
  assert.equal(htmlToText('<p>Visible</p><script>never closed <p>hidden</p>'), 'Visible');
  assert.equal(htmlToText('<p>Visible</p><!-- never closed'), 'Visible');
});

test('formatFieldValue: hostile HTML stays fast and is cut at 20k characters', () => {
  for (const hostile of ['<b>' + '<'.repeat(100_000), '<p>' + '<script>'.repeat(20_000), '<p>' + '<!--'.repeat(30_000), '<p><li' + ' '.repeat(100_000)]) {
    const start = performance.now();
    const out = formatFieldValue('description', hostile);
    assert.ok(performance.now() - start < 200, `${hostile.slice(0, 12)}… took ${Math.round(performance.now() - start)} ms`);
    assert.ok(out.length <= 20_001);
  }
  assert.ok(htmlToText('<p>' + 'a'.repeat(30_000) + '</p>').endsWith('…'));
});

test('formatFieldValue: prose with angle brackets is not taken for HTML', () => {
  assert.equal(formatFieldValue('note', 'x <y> z'), 'x <y> z');
  assert.equal(formatFieldValue('note', 'pack <12 units> only'), 'pack <12 units> only');
  assert.equal(formatFieldValue('description', '<b>Picante</b>'), 'Picante');
});
