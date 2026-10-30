import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Listing, ProductIdentity, ScrapeRequest, SearchRequest, SourcePage } from './types.ts';
import {
  checkErrorBody,
  checkJob,
  checkListing,
  checkProductIdentity,
  checkProductListings,
  checkScraperMatches,
  checkScrapeResult,
  checkSearchResult,
  Issues,
} from './validate.ts';

const identity: ProductIdentity = {
  id: 'doritos-nacho-61-g',
  brand: 'Doritos',
  productName: 'Doritos Nacho',
  size: '61 g',
  imageUrl: 'https://images.openfoodfacts.org/x.jpg',
  imageSource: 'openfoodfacts',
  confidence: 0.9,
  source: 'claude',
};

const page: SourcePage = {
  id: 'pg-1',
  url: 'https://super.walmart.com.mx/ip/doritos/1',
  domain: 'super.walmart.com.mx',
  retailerName: 'Walmart Súper',
  sourceType: 'third_party',
  title: 'Doritos Nacho 61 g',
  matchType: 'exact',
  verification: { status: 'verified', confidence: 0.9, reason: 'Same product' },
  scraper: { status: 'available', scraperId: 'scr-walmart' },
};

const listing: Listing = {
  id: 'l-1',
  pageId: 'pg-1',
  url: page.url,
  domain: page.domain,
  retailerName: page.retailerName,
  price: { amount: 21.5, currency: 'MXN' },
  categoryPath: ['Despensa', 'Botanas'],
  standardTaxonomy: { system: 'Google Product Taxonomy', path: ['Food, Beverages & Tobacco'], code: '2392' },
  fields: { net_weight: '61 g', rating: 4.5, in_stock: true, promo: null },
  scrapedAt: '2026-10-28T18:30:00.000Z',
};

/** Paths of the errors a check found. */
function errors(fn: (is: Issues) => void): string[] {
  const is = new Issues();
  fn(is);
  return is.list.filter((i) => i.severity === 'error').map((i) => i.path);
}

test('good shapes have no errors', () => {
  assert.deepEqual(errors((is) => checkProductIdentity(identity, 'p', is)), []);
  assert.deepEqual(errors((is) => checkListing(listing, 'l', is)), []);
  assert.deepEqual(errors((is) => checkErrorBody({ error: 'Product not found', code: 'not_found' }, 'e', is)), []);
});

test('error body must be a string, not the old nested object', () => {
  assert.deepEqual(errors((is) => checkErrorBody({ error: { code: 'not_found', message: 'x' } }, 'e', is)), ['e.error']);
  assert.deepEqual(errors((is) => checkErrorBody('Not found', 'e', is)), ['e']);
});

test('identity: required fields, ranges and user_photo', () => {
  const bad = { ...identity, brand: '', confidence: 1.4, source: 'ai', imageSource: 'user_photo' };
  assert.deepEqual(errors((is) => checkProductIdentity(bad, 'p', is, 'identify')).sort(), ['p.brand', 'p.confidence', 'p.imageSource', 'p.source']);
});

test('an echoed user edit with a local photo is legal (a warning, not an error)', () => {
  const edited = { ...identity, source: 'user_edited', imageUrl: 'file:///var/mobile/photo.jpg', imageSource: 'user_photo' };
  assert.deepEqual(errors((is) => checkProductIdentity(edited, 'p', is)), []);
  assert.deepEqual(errors((is) => checkProductIdentity(edited, 'p', is, 'identify')).sort(), ['p.imageSource']);
});

test('job: unknown step key, missing result or error', () => {
  assert.deepEqual(errors((is) => checkJob({ jobId: 'j', status: 'running', progress: { step: 'searching_web', message: '' } }, 'j', is, 'search')), ['j.progress.step']);
  assert.deepEqual(errors((is) => checkJob({ jobId: 'j', status: 'running', progress: { step: 'verify', message: 'x', percent: 40 } }, 'j', is, 'search')), []);
  assert.deepEqual(errors((is) => checkJob({ jobId: 'j', status: 'succeeded' }, 'j', is, 'scrape')), ['j.result']);
  assert.deepEqual(errors((is) => checkJob({ jobId: 'j', status: 'failed' }, 'j', is, 'build')), ['j.error']);
});

test('search result: product id, similar links, scan type, duplicates', () => {
  const req: SearchRequest = { product: identity, scanType: 'third_party', includeSimilar: true, region: 'MX' };
  const brand: SourcePage = { ...page, id: 'pg-2', url: 'https://www.doritos.com.mx/p', domain: 'doritos.com.mx', sourceType: 'first_party' };
  const orphan: SourcePage = { ...page, id: 'pg-3', matchType: 'similar', similarProductId: 'nope' };
  const result = { searchId: 's', product: { ...identity, id: 'other' }, pages: [page, page, brand, orphan], similarProducts: [] };
  assert.deepEqual(errors((is) => checkSearchResult(result, 'r', is, req)).sort(), ['r.pages[1].id', 'r.pages[2].sourceType', 'r.pages[3].similarProductId', 'r.product.id']);
});

test('listing: nested fields, bad date, code type', () => {
  const bad = { ...listing, fields: { nutrition: { kcal: 500 } }, scrapedAt: 'yesterday', standardTaxonomy: { system: 'GPT', path: ['Food'], code: 2392 } };
  assert.deepEqual(errors((is) => checkListing(bad, 'l', is)).sort(), ['l.fields.nutrition', 'l.scrapedAt', 'l.standardTaxonomy.code']);
});

test('scrape result: every requested page is a listing or a failure', () => {
  const req: ScrapeRequest = { searchId: 's', productId: identity.id, pageIds: ['pg-1', 'pg-2'] };
  const ok = { runId: 'r', saved: true, savedAt: '2026-10-28T18:31:04.000Z', listings: [listing], failures: [{ pageId: 'pg-2', url: 'https://x.mx/p', error: 'Timed out' }] };
  assert.deepEqual(errors((is) => checkScrapeResult(ok, 'r', is, req)), []);
  assert.deepEqual(errors((is) => checkScrapeResult({ ...ok, failures: [] }, 'r', is, req)), ['r']);
});

test('product listings: one listing per page', () => {
  assert.deepEqual(errors((is) => checkProductListings({ product: identity, listings: [listing, { ...listing, id: 'l-2' }] }, 'p', is, identity.id)), ['p.listings[1].pageId']);
});

test('scraper matches: one per URL, same order', () => {
  const urls = ['https://a.mx/1', 'https://b.mx/2'];
  const swapped = { matches: [{ url: urls[1], domain: 'b.mx', status: 'missing' }, { url: urls[0], domain: 'a.mx', status: 'available' }] };
  assert.deepEqual(errors((is) => checkScraperMatches(swapped, 'm', is, urls)).sort(), ['m.matches[0].url', 'm.matches[1].scraperId', 'm.matches[1].url']);
});

/** Paths of the warnings a check found. */
function warnings(fn: (is: Issues) => void): string[] {
  const is = new Issues();
  fn(is);
  return is.list.filter((i) => i.severity === 'warning').map((i) => i.path);
}

test('failure codes: optional strings; known ones pass, unknown ones warn', () => {
  const req: ScrapeRequest = { searchId: 's', productId: identity.id, pageIds: ['pg-1', 'pg-2', 'pg-3'] };
  const failures = [
    { pageId: 'pg-2', url: 'https://x.mx/p', error: 'Not collected: robots.txt blocks AI agents (ClaudeBot)', code: 'ai_opt_out', retailerName: 'X' },
    { pageId: 'pg-3', url: 'https://y.mx/p', error: 'Timed out' },
  ];
  const ok = { runId: 'r', saved: true, savedAt: '2026-10-28T18:31:04.000Z', listings: [listing], failures };
  assert.deepEqual(errors((is) => checkScrapeResult(ok, 'r', is, req)), []);
  assert.deepEqual(warnings((is) => checkScrapeResult({ ...ok, failures: [{ ...failures[0], code: 'geo_blocked' }, failures[1]] }, 'r', is, req)), ['r.failures[0].code']);
  const bad = { ...ok, failures: [{ ...failures[0], code: 403 }, { ...failures[1], retailerName: 7 }] };
  assert.deepEqual(errors((is) => checkScrapeResult(bad, 'r', is, req)).sort(), ['r.failures[0].code', 'r.failures[1].retailerName']);
});

test('page access: shape, and a refused page is never "available"', () => {
  const req: SearchRequest = { product: identity, scanType: 'both', includeSimilar: false, region: 'MX' };
  const refused = { status: 'refused', code: 'ai_opt_out', label: 'Blocks AI agents', reason: 'robots.txt blocks AI agents (ClaudeBot)', alternative: null };
  const ok = { ...page, scraper: { status: 'missing' }, access: refused };
  const run = (pages: unknown[]) => errors((is) => checkSearchResult({ searchId: 's', product: identity, pages, similarProducts: [] }, 'r', is, req));
  assert.deepEqual(run([ok, { ...page, id: 'pg-2', access: { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' } }]), []);
  assert.deepEqual(run([{ ...ok, scraper: { status: 'available', scraperId: 's' } }]), ['r.pages[0].scraper.status']);
  assert.deepEqual(run([{ ...ok, access: { status: 'blocked', code: 'x' } }]).sort(), ['r.pages[0].access.reason', 'r.pages[0].access.status']);
});

test('product listings: optional failures, none for a page that has a listing', () => {
  const ok = { product: identity, listings: [listing], failures: [{ pageId: 'pg-2', url: 'https://x.mx/p', error: 'Timed out', code: 'unreachable' }] };
  assert.deepEqual(errors((is) => checkProductListings(ok, 'p', is, identity.id)), []);
  const bad = { ...ok, failures: [{ pageId: 'pg-1', url: page.url, error: 'Forbidden', code: 'blocked' }] };
  assert.deepEqual(errors((is) => checkProductListings(bad, 'p', is, identity.id)), ['p.failures[0].pageId']);
});
