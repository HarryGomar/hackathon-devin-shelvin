// Run: npm test
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { ProductIdentity, ScrapeResult, SearchResult, SourcePage } from '@/api/types';

import { isDefaultSelected, useSession } from './session';

const doritos: ProductIdentity = {
  id: 'doritos-incognita',
  brand: 'Doritos',
  productName: 'Doritos Incógnita',
  size: '62 g',
  confidence: 0.95,
  source: 'mock',
};
const search = { searchId: 's1', product: doritos, pages: [], similarProducts: [] } as unknown as SearchResult;

beforeEach(() => {
  const s = useSession.getState();
  s.reset();
  s.startScan({ kind: 'barcode', code: '7500000000017' });
  s.setIdentity(doritos);
  s.setSearchJobId('job1');
  s.setSearch(search);
});

test('same identity fields keep the search', () => {
  useSession.getState().setIdentity({ ...doritos, imageUrl: 'https://example.com/x.png', confidence: 1 });
  assert.equal(useSession.getState().search, search);
  assert.equal(useSession.getState().searchJobId, 'job1');
});

test('editing only the size (same id) drops the search', () => {
  useSession.getState().setIdentity({ ...doritos, size: '145 g', source: 'user_edited' });
  assert.equal(useSession.getState().search, undefined);
  assert.equal(useSession.getState().searchJobId, undefined);
});

test('editing the barcode drops the search', () => {
  useSession.getState().setIdentity({ ...doritos, barcode: '7500000000024' });
  assert.equal(useSession.getState().search, undefined);
});

test('picking another product clears the scan input and the search', () => {
  useSession.getState().pickOtherProduct({ ...doritos, id: 'takis-fuego', brand: 'Takis', productName: 'Takis Fuego' });
  const s = useSession.getState();
  assert.equal(s.input, undefined);
  assert.equal(s.identity?.id, 'takis-fuego');
  assert.equal(s.search, undefined);
});

test('resuming a saved product starts fresh with its saved pages marked as scraped', () => {
  const takis = { ...doritos, id: 'takis-fuego', brand: 'Takis', productName: 'Takis Fuego' };
  useSession.getState().resumeProduct(takis, ['takis-fuego--walmart', 'takis-fuego--soriana', 'takis-fuego--walmart']);
  const s = useSession.getState();
  assert.equal(s.input, undefined);
  assert.equal(s.identity, takis);
  assert.equal(s.search, undefined);
  assert.equal(s.searchJobId, undefined);
  assert.equal(s.lastScrape, undefined);
  assert.deepEqual(s.scrapedPageIds, ['takis-fuego--walmart', 'takis-fuego--soriana']);
});

test('a search after resuming leaves the saved pages unselected', () => {
  const page = (id: string) =>
    ({ id, scraper: { status: 'available' }, verification: { status: 'verified', confidence: 1, reason: '' } }) as unknown as SearchResult['pages'][number];
  useSession.getState().resumeProduct(doritos, ['doritos-incognita--walmart']);
  useSession.getState().setSearch({ ...search, pages: [page('doritos-incognita--walmart'), page('doritos-incognita--soriana')] });
  assert.deepEqual(useSession.getState().selectedPageIds, ['doritos-incognita--soriana']);
});

const page = (id: string): SourcePage => ({
  id,
  url: `https://${id}.mx/p`,
  domain: `${id}.mx`,
  retailerName: id,
  sourceType: 'third_party',
  title: id,
  matchType: 'exact',
  verification: { status: 'verified', confidence: 0.9, reason: 'same product' },
  scraper: { status: 'available', scraperId: `scr-${id}` },
  access: { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' },
});
const withPages = { ...search, pages: [page('heb'), page('bodega'), page('walmart')] } as SearchResult;
const scrape = (failures: ScrapeResult['failures'], listingPageIds: string[] = []): ScrapeResult =>
  ({ runId: 'r', saved: true, listings: listingPageIds.map((pageId) => ({ pageId })), failures }) as unknown as ScrapeResult;
const heb403 = { pageId: 'heb', url: 'https://heb.mx/p', error: 'The site answered 403', code: 'blocked' };
const selected = () => useSession.getState().selectedPageIds;
const accessOf = (id: string) => useSession.getState().pages.find((p) => p.id === id)?.access;

test('a page the site refused during a scrape is refused for "Scrape more"; a timeout is not', () => {
  const s = useSession.getState();
  s.setSearch(withPages);
  s.setScrapeResult(scrape([heb403, { pageId: 'bodega', url: 'https://bodega.mx/p', error: 'Timed out', code: 'unreachable' }], ['walmart']));
  assert.deepEqual(accessOf('heb'), { status: 'refused', code: 'blocked', reason: 'The site answered 403' });
  assert.equal(accessOf('bodega')?.status, 'allowed');
  const heb = useSession.getState().pages.find((p) => p.id === 'heb')!;
  assert.equal(isDefaultSelected(heb, []), false);
});

test('it stays refused in a new search of the same product, and is not pre-ticked', () => {
  const s = useSession.getState();
  s.setSearch(withPages);
  s.setScrapeResult(scrape([heb403]));
  useSession.getState().setScanOptions({ includeSimilar: false });
  useSession.getState().setSearch(withPages);
  assert.equal(accessOf('heb')?.code, 'blocked');
  assert.deepEqual([...selected()].sort(), ['bodega', 'walmart']);
});

test('Find more pages: a saved blocking failure keeps the page refused; other failures do not', () => {
  useSession.getState().resumeProduct(doritos, ['walmart'], [heb403, { pageId: 'bodega', url: 'https://bodega.mx/p', error: 'Timed out', code: 'unreachable' }]);
  useSession.getState().setSearch(withPages);
  assert.equal(accessOf('heb')?.status, 'refused');
  assert.deepEqual(selected(), ['bodega']);
});

test('a page that gets a listing later is no longer blocked; a refusal from the search itself wins', () => {
  const s = useSession.getState();
  s.setSearch(withPages);
  s.setScrapeResult(scrape([heb403]));
  useSession.getState().setScrapeResult(scrape([], ['heb']));
  useSession.getState().setSearch(withPages);
  assert.equal(accessOf('heb')?.status, 'allowed');
  const optOut = { status: 'refused', code: 'ai_opt_out', reason: 'robots.txt blocks AI agents' } as const;
  useSession.getState().setScrapeResult(scrape([heb403]));
  useSession.getState().setSearch({ ...withPages, pages: [{ ...page('heb'), access: optOut }] } as SearchResult);
  assert.deepEqual(accessOf('heb'), optOut);
});

test('builds: tracked per site, updated from polls of the same job only, and kept across a new scan', () => {
  const { trackBuild, updateBuild } = useSession.getState();
  trackBuild('chedraui.com.mx', 'job-1', 'p1');
  assert.equal(useSession.getState().builds['chedraui.com.mx'].status, 'queued');
  updateBuild('chedraui.com.mx', { jobId: 'job-1', status: 'running', progress: { step: 'gate', message: 'Gate' } });
  assert.equal(useSession.getState().builds['chedraui.com.mx'].progress?.step, 'gate');
  updateBuild('chedraui.com.mx', { jobId: 'old-job', status: 'failed' });
  assert.equal(useSession.getState().builds['chedraui.com.mx'].status, 'running', 'a poll of another job is ignored');
  updateBuild('chedraui.com.mx', { jobId: 'job-1', status: 'running' }, 'Network error');
  assert.equal(useSession.getState().builds['chedraui.com.mx'].status, 'failed', 'a polling error ends the build');
  useSession.getState().startScan({ kind: 'manual', code: '1' });
  assert.ok(useSession.getState().builds['chedraui.com.mx'], 'a new scan keeps the builds');
  trackBuild('chedraui.com.mx', 'job-2');
  assert.equal(useSession.getState().builds['chedraui.com.mx'].jobId, 'job-2');
});

test('a rate-limited page stays selectable for the next scrape; a blocked one is refused', () => {
  const { setSearch, setScrapeResult } = useSession.getState();
  const page = (id: string): SourcePage => ({
    id,
    url: `https://shop.mx/${id}`,
    domain: 'shop.mx',
    retailerName: 'Shop',
    sourceType: 'third_party',
    title: id,
    matchType: 'exact',
    verification: { status: 'verified', confidence: 0.9, reason: 'Same product' },
    scraper: { status: 'available', scraperId: 'shop_mx' },
  });
  setSearch({ searchId: 's-rl', product: useSession.getState().identity!, pages: [page('slow'), page('no')], similarProducts: [] });
  setScrapeResult({
    runId: 'r',
    saved: false,
    listings: [],
    failures: [
      { pageId: 'slow', url: 'https://shop.mx/slow', error: '429', code: 'rate_limited' },
      { pageId: 'no', url: 'https://shop.mx/no', error: '403', code: 'blocked' },
    ],
  });
  const pages = useSession.getState().pages;
  assert.equal(pages.find((p) => p.id === 'slow')?.access?.status, undefined);
  assert.equal(pages.find((p) => p.id === 'no')?.access?.status, 'refused');
});
