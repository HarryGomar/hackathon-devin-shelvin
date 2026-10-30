// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BrandCatalog, Listing } from '@/api/types';

import { catalogMatchIndex, catalogPriceCurrency, catalogVisibleRows } from './catalog';

const row = (i: number, over: Partial<Listing> = {}): Listing => ({
  id: `cat-${i}`,
  pageId: 'barcel--first-party',
  url: `https://barcel.com.mx/productos/${i}`,
  domain: 'barcel.com.mx',
  retailerName: 'Barcel (official site)',
  title: `Product ${i}`,
  fields: {},
  scrapedAt: '2026-10-29T06:00:00Z',
  ...over,
});

const catalog = (n: number): BrandCatalog => ({
  pageId: 'barcel--first-party',
  domain: 'barcel.com.mx',
  retailerName: 'Barcel (official site)',
  source: 'barcel_mx',
  count: n,
  scrapedAt: '2026-10-29T06:00:00Z',
  listings: Array.from({ length: n }, (_, i) => row(i)),
});

test('the scanned product is the catalog row matching the listing the scrape kept for that page', () => {
  const c = catalog(12);
  const matched = { ...row(9), id: 'lst-run-barcel--first-party-0' };
  assert.equal(catalogMatchIndex(c, [matched]), 9);
  assert.equal(catalogMatchIndex(c, [{ ...matched, url: 'https://barcel.com.mx/otra' }]), 9, 'same title is enough');
  assert.equal(catalogMatchIndex(c, []), -1, 'no listing for the page: nothing is marked');
  assert.equal(catalogMatchIndex(c, [{ ...matched, pageId: 'other' }]), -1);
});

test('visible rows: the first 8, plus the scanned one when it is further down; everything with show all', () => {
  const c = catalog(12);
  assert.deepEqual(catalogVisibleRows(c, 2, 8, false).map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(catalogVisibleRows(c, 10, 8, false).map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 10]);
  assert.equal(catalogVisibleRows(c, 10, 8, true).length, 12);
  assert.equal(catalogVisibleRows(catalog(5), -1, 8, false).length, 5);
});

test('price column: from the first row with a price to show; an out-of-stock placeholder neither shows nor decides it', () => {
  const placeholder = row(0, { price: { amount: 1, currency: 'MXN' }, fields: { available: false } });
  assert.equal(catalogPriceCurrency({ ...catalog(0), listings: [placeholder, row(1)] }), undefined, 'only a placeholder: no column');
  const listed = row(2, { price: { amount: 18.5, currency: 'MXN' } });
  assert.equal(catalogPriceCurrency({ ...catalog(0), listings: [placeholder, listed] }), 'MXN');
  assert.equal(catalogPriceCurrency(catalog(3)), undefined, 'a brand site with no prices');
});
