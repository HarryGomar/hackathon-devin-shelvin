// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retailerLabel } from './retailer';

test('retailerLabel: official suffix is dropped and marks the brand site', () => {
  assert.deepEqual(retailerLabel('Takis (official site)'), { name: 'Takis', official: true });
  assert.deepEqual(retailerLabel('Doritos (Sitio oficial) '), { name: 'Doritos', official: true });
  assert.deepEqual(retailerLabel('Walmart Súper'), { name: 'Walmart Súper', official: false });
});

test('retailerLabel: the page source type wins over the name', () => {
  assert.deepEqual(retailerLabel('Takis México', 'first_party'), { name: 'Takis México', official: true });
  assert.deepEqual(retailerLabel('Takis (official site)', 'third_party'), { name: 'Takis', official: false });
  assert.deepEqual(retailerLabel('(official site)'), { name: '(official site)', official: false });
});
