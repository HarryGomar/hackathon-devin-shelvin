// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SourcePage } from '@/api/types';

import { batchBuildPageIds, buildablePages, isRefused, isScrapable, isValidPageUrl } from './pages';

const page = (id: string, domain: string, over: Partial<SourcePage> = {}): SourcePage => ({
  id,
  url: `https://${domain}/p/${id}`,
  domain,
  retailerName: domain,
  sourceType: 'third_party',
  title: id,
  matchType: 'exact',
  verification: { status: 'verified', confidence: 0.9, reason: 'Same product' },
  scraper: { status: 'missing' },
  ...over,
});

const refused = { status: 'refused', code: 'ai_opt_out', reason: 'robots.txt blocks AI agents' } as const;

test('page URL: http(s) with a dotted host is valid', () => {
  assert.equal(isValidPageUrl('https://www.walmart.com.mx/ip/doritos-incognita/750100'), true);
  assert.equal(isValidPageUrl('http://soriana.com'), true);
  assert.equal(isValidPageUrl('  https://chedraui.com.mx/p?id=1  '), true, 'surrounding spaces are trimmed');
});

test('page URL: missing scheme, other schemes, bare hosts and spaces are invalid', () => {
  assert.equal(isValidPageUrl(''), false);
  assert.equal(isValidPageUrl('walmart.com.mx/ip/1'), false);
  assert.equal(isValidPageUrl('ftp://walmart.com.mx'), false);
  assert.equal(isValidPageUrl('https://localhost'), false);
  assert.equal(isValidPageUrl('https://wal mart.com'), false);
  assert.equal(isValidPageUrl('https://walmart.c'), false, 'top-level domain needs 2+ chars');
});

test('buildable pages: one per site without a scraper; refused, rejected and available ones are left out', () => {
  const pages = [
    page('a', 'chedraui.com.mx'),
    page('b', 'chedraui.com.mx'),
    page('c', 'lacomer.com.mx'),
    page('d', 'amazon.com.mx', { access: refused }),
    page('e', 'mercadolibre.com.mx', { verification: { status: 'rejected', confidence: 0.2, reason: 'Bundle' } }),
    page('f', 'super.walmart.com.mx', { scraper: { status: 'available', scraperId: 'walmart_mx' } }),
  ];
  assert.deepEqual(buildablePages(pages).map((p) => p.id), ['a', 'c']);
  // The batch also sends the refused page, so the backend's skipped[] says why it gets no build.
  assert.deepEqual(batchBuildPageIds(pages), ['a', 'b', 'c', 'd']);
});

test('a refused page is never scrapable, even with a scraper', () => {
  const p = page('d', 'amazon.com.mx', { access: refused, scraper: { status: 'available', scraperId: 'amazon_mx' } });
  assert.equal(isRefused(p), true);
  assert.equal(isScrapable(p), false);
  assert.equal(isScrapable({ ...p, access: undefined }), true, 'no access field (older backend) means allowed');
});
