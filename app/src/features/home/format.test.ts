// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatLastScraped, normalizeBarcode } from './format';
import { homeStrings } from './strings';

test('barcode: EAN-13, UPC-A and EAN-8 lengths are valid', () => {
  assert.deepEqual(normalizeBarcode('7500000000017'), { code: '7500000000017', valid: true });
  assert.equal(normalizeBarcode('012345678905').valid, true);
  assert.equal(normalizeBarcode('96385074').valid, true);
});

test('barcode: spaces and dashes are stripped', () => {
  assert.deepEqual(normalizeBarcode(' 750 0000-000017 '), { code: '7500000000017', valid: true });
});

test('barcode: wrong length or non-digits are invalid', () => {
  assert.equal(normalizeBarcode('').valid, false);
  assert.equal(normalizeBarcode('12345').valid, false);
  assert.equal(normalizeBarcode('75000000000170').valid, false, '14 digits');
  assert.equal(normalizeBarcode('75000000000A7').valid, false);
});

test('last scraped: today, yesterday, or a date', () => {
  const now = new Date(2026, 9, 28, 15, 0);
  assert.ok(formatLastScraped(new Date(2026, 9, 28, 9, 30).toISOString(), now).startsWith(`${homeStrings.today} `));
  assert.ok(formatLastScraped(new Date(2026, 9, 27, 23, 0).toISOString(), now).startsWith(`${homeStrings.yesterday} `));
  const older = formatLastScraped(new Date(2026, 9, 20, 8, 0).toISOString(), now);
  assert.ok(!older.startsWith(homeStrings.today) && !older.startsWith(homeStrings.yesterday));
  assert.equal(formatLastScraped('not a date', now), 'not a date');
});
