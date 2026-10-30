// Run: npm test  (node --test, no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeBarcode, gtinCheckDigit, isValidGtin, lookupCandidates, normalizeGtin, productIdFor, productSlug, sizeKey } from './gtin.ts';

test('check digit: EAN-13, UPC-A, EAN-8, GTIN-14', () => {
  assert.equal(gtinCheckDigit('750101112358'), 8, 'Doritos Nacho 7501011123588');
  assert.equal(isValidGtin('7501011123588'), true);
  assert.equal(isValidGtin('7501011123587'), false, 'one digit off');
  assert.equal(isValidGtin('036000291452'), true, 'UPC-A');
  assert.equal(isValidGtin('75007614'), true, 'EAN-8 Coca-Cola 600 ml');
  assert.equal(isValidGtin('07315122013887'), true, 'GTIN-14');
  assert.equal(isValidGtin('7500000000017'), false, 'the mock fixtures use fictional codes');
  assert.equal(isValidGtin('123'), false);
  assert.equal(isValidGtin('75010111235a8'), false);
});

test('normalizeGtin: every way of writing the same code gives one GTIN-14', () => {
  for (const code of ['7315122013887', '07315122013887', '007315122013887', ' 7315122013887\n', '7 315122 013887']) {
    assert.equal(normalizeGtin(code), '07315122013887', code);
  }
  assert.equal(normalizeGtin('036000291452'), '00036000291452', 'UPC-A left-padded');
  assert.equal(normalizeGtin('0036000291452'), '00036000291452', 'UPC-A as iOS reports it (EAN-13 with a leading 0)');
  assert.equal(normalizeGtin('75007614'), '00000075007614', 'EAN-8 stays EAN-8, padded');
  assert.equal(normalizeGtin('7315122013886'), undefined, 'wrong check digit');
  assert.equal(normalizeGtin(''), undefined);
  assert.equal(normalizeGtin(undefined), undefined);
});

test('describeBarcode says the format and whether the check digit is right', () => {
  assert.deepEqual(describeBarcode('036000291452'), { digits: '036000291452', format: 'UPC-A', checkDigitValid: true, gtin14: '00036000291452' });
  assert.deepEqual(describeBarcode('7501011123587'), { digits: '7501011123587', format: 'EAN-13', checkDigitValid: false, gtin14: undefined });
});

test('lookup candidates: as scanned first, then the other spellings of the same GTIN', () => {
  assert.deepEqual(lookupCandidates('7501011123588'), ['7501011123588']);
  assert.deepEqual(lookupCandidates('036000291452'), ['036000291452', '0036000291452']);
  assert.deepEqual(lookupCandidates('0036000291452'), ['0036000291452', '036000291452']);
  assert.deepEqual(lookupCandidates('07315122013887'), ['07315122013887', '7315122013887']);
  assert.deepEqual(lookupCandidates('75007614'), ['75007614', '0000075007614']);
  assert.deepEqual(lookupCandidates('7501011123587'), ['7501011123587'], 'invalid code: only as scanned');
  assert.deepEqual(lookupCandidates(''), []);
});

test('size key: same amount and unit, however it is written', () => {
  for (const s of ['100 g', '100g', '100 gr', '100 GRS', '100 gramos', '100g.']) assert.equal(sizeKey(s), '100g', s);
  assert.equal(sizeKey('1,5 L'), '1-5l');
  assert.equal(sizeKey('1.5 lt'), '1-5l');
  assert.equal(sizeKey('600ml'), '600ml');
  assert.equal(sizeKey('1.0 kg'), '1kg');
  assert.equal(sizeKey('62 g (2.18 oz)'), '62g');
  assert.equal(sizeKey('12 fl oz'), '12floz');
  assert.equal(sizeKey(undefined), '');
  assert.equal(sizeKey('familiar'), 'familiar');
});

test('slug: brand not repeated, accents/case/punctuation and size spelling ignored', () => {
  const a = productSlug({ brand: 'IKEA', productName: 'Choklad Nöt', size: '100 g' });
  assert.equal(a, 'ikea-choklad-not-100g');
  assert.equal(productSlug({ brand: 'IKEA', productName: 'IKEA CHOKLAD NÖT', size: '100g' }), a);
  assert.equal(productSlug({ brand: 'ikea', productName: 'ikea choklad nöt.', size: '100 gr' }), a);
  assert.equal(productSlug({ brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', size: '62 g' }), 'doritos-incognita-62g');
  assert.equal(
    productSlug({ brand: 'IKEA', productName: 'Choklad', variant: 'Mörk', size: '100 g' }),
    'ikea-choklad-mork-100g',
    'a variant the name lacks keeps flavors apart',
  );
  assert.equal(productSlug({}), 'product');
});

test('product id: gtin- + GTIN-14 with a valid barcode, else the slug', () => {
  const choklad = { brand: 'IKEA', productName: 'Choklad Nöt', size: '100 g' };
  assert.equal(productIdFor({ ...choklad, barcode: '7315122013887' }), 'gtin-07315122013887');
  assert.equal(productIdFor({ brand: 'x', productName: 'other name', barcode: '007315122013887' }), 'gtin-07315122013887', 'name does not matter');
  assert.equal(productIdFor({ ...choklad, barcode: '7315122013886' }), 'ikea-choklad-not-100g', 'invalid barcode → slug');
  assert.equal(productIdFor(choklad), 'ikea-choklad-not-100g');
});
