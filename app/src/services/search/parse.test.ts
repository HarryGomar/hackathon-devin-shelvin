// Run: npm test  (node --test with native TypeScript stripping; no network, no API calls)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProductIdentity, SearchRequest } from '@/api/types';

import {
  brandDomainGuesses,
  buildSearchPrompt,
  collectSeenUrls,
  domainPolicy,
  extractJson,
  normalizeUrl,
  pageIdFor,
  parseSearchResponse,
  SearchError,
} from './parse.ts';

const doritos: ProductIdentity = {
  id: 'doritos-nacho-62-g',
  brand: 'Doritos',
  productName: 'Doritos Nacho',
  variant: 'Nacho',
  size: '62 g',
  barcode: '7501011123588',
  manufacturer: 'Sabritas (PepsiCo México)',
  confidence: 0.9,
  source: 'claude',
};

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({ product: doritos, scanType: 'both', includeSimilar: false, region: 'MX', ...over });

const WALMART = 'https://super.walmart.com.mx/ip/doritos-nacho-62-g/00750101112358';
const SORIANA = 'https://www.soriana.com/doritos-nacho-62g/9999.html';
const OFFICIAL = 'https://www.sabritas.com.mx/productos/doritos-nacho';
const AMAZON = 'https://www.amazon.com.mx/dp/B07XYZ?ref=sr_1_1';
const ML = 'https://articulo.mercadolibre.com.mx/MLM-123-doritos-nacho-6-pack-_JM';

/** A search tool result block listing these URLs, like the API returns. */
const searchResult = (...urls: string[]) => ({
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_1',
  content: urls.map((url) => ({ type: 'web_search_result', url, title: 't', encrypted_content: 'x' })),
});

const page = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  title: 'Doritos Nacho 62 g',
  retailerName: 'Store',
  sourceType: 'third_party',
  verdict: 'verified',
  confidence: 0.9,
  reason: 'Same brand, flavor and size',
  ...over,
});

const respond = (answer: unknown, tools: unknown[] = [searchResult(WALMART, SORIANA, OFFICIAL, AMAZON, ML)], stop = 'end_turn') => ({
  stop_reason: stop,
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Doritos Nacho 62 g' } },
    ...tools,
    { type: 'thinking', thinking: '' },
    { type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) },
  ],
});

test('good response → ranked contract pages with stable ids', () => {
  const answer = {
    pages: [
      page(SORIANA, { verdict: 'uncertain', confidence: 0.7, reason: 'Size not shown' }),
      page(WALMART),
      page(OFFICIAL, { sourceType: 'first_party', retailerName: 'Sabritas' }),
      page(ML, { verdict: 'rejected', confidence: 0.2, reason: '6-pack' }),
    ],
    similarProducts: [],
  };
  const { pages, similarProducts } = parseSearchResponse(respond(answer), req());
  assert.deepEqual(
    pages.map((p) => p.domain),
    ['sabritas.com.mx', 'super.walmart.com.mx', 'soriana.com', 'articulo.mercadolibre.com.mx'],
    'first party first, then verified → uncertain → rejected',
  );
  const walmart = pages[1];
  assert.equal(walmart.id, pageIdFor(WALMART));
  assert.equal(walmart.id, pageIdFor(WALMART.replace('https://', 'http://www.') + '/'), 'id ignores protocol, www, trailing slash');
  assert.equal(walmart.retailerName, 'Walmart Súper', 'known store name wins over Claude’s');
  assert.equal(walmart.sourceType, 'third_party');
  assert.equal(walmart.matchType, 'exact');
  assert.deepEqual(walmart.verification, { status: 'verified', confidence: 0.9, reason: 'Same brand, flavor and size' });
  assert.deepEqual(walmart.scraper, { status: 'missing' });
  assert.equal(pages[0].retailerName, 'Sabritas');
  assert.equal(pages[3].retailerName, 'Mercado Libre', 'subdomain maps to the store');
  assert.equal(pages[3].verification.status, 'rejected');
  assert.deepEqual(similarProducts, []);
});

test('similar products get ids and pages marked similar', () => {
  const answer = {
    pages: [page(WALMART)],
    similarProducts: [
      { brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', relation: 'same_brand', reason: 'Same line', pages: [page(SORIANA), page(AMAZON), page(ML)] },
      { brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', relation: 'competitor', reason: 'Spicy rival', pages: [] },
      { brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', relation: 'same_brand', reason: 'dup of main', pages: [] },
    ],
  };
  const { pages, similarProducts } = parseSearchResponse(respond(answer), req({ includeSimilar: true }));
  assert.deepEqual(
    similarProducts.map((s) => [s.id, s.relation]),
    [
      ['similar-doritos-incognita-incognita', 'same_brand'],
      ['similar-takis-fuego-fuego', 'competitor'],
    ],
    'the main product is not listed as similar to itself',
  );
  const similar = pages.filter((p) => p.matchType === 'similar');
  assert.equal(similar.length, 2, 'at most 2 pages per similar product');
  assert.ok(similar.every((p) => p.similarProductId === 'similar-doritos-incognita-incognita'));
  assert.equal(pages[0].matchType, 'exact', 'exact pages first');
});

test('similar products are dropped when not asked for', () => {
  const answer = { pages: [page(WALMART)], similarProducts: [{ brand: 'Takis', productName: 'Takis Fuego', variant: '', relation: 'competitor', reason: 'x', pages: [page(SORIANA)] }] };
  const { pages, similarProducts } = parseSearchResponse(respond(answer), req());
  assert.equal(similarProducts.length, 0);
  assert.equal(pages.length, 1);
});

test('partial response: bad pages are dropped, the rest kept', () => {
  const answer = {
    pages: [
      page(WALMART, { verdict: 'probably', confidence: 87, reason: '' }),
      page('not a url'),
      page('https://www.walmart.com/ip/doritos/123'), // US Walmart, not allowed
      page('https://randomblog.mx/doritos-review'), // unknown site claimed as a store
      page(SORIANA),
      page(SORIANA + '?utm=x', { confidence: 0.4 }), // duplicate
      null,
    ],
    similarProducts: 'oops',
  };
  const { pages } = parseSearchResponse(respond(answer), req({ includeSimilar: true }));
  assert.deepEqual(pages.map((p) => p.domain).sort(), ['soriana.com', 'super.walmart.com.mx']);
  const walmart = pages.find((p) => p.domain === 'super.walmart.com.mx')!;
  assert.equal(walmart.verification.status, 'uncertain', 'unknown verdict → uncertain');
  assert.equal(walmart.verification.confidence, 0.87, 'percent → 0..1');
  assert.ok(walmart.verification.reason.length > 0);
  assert.equal(pages.find((p) => p.domain === 'soriana.com')!.verification.confidence, 0.9, 'better duplicate kept');
});

test('URL never returned by the search is downgraded, not trusted', () => {
  const invented = 'https://www.chedraui.com.mx/doritos-nacho-62g/p';
  const { pages } = parseSearchResponse(respond({ pages: [page(WALMART), page(invented)], similarProducts: [] }), req());
  const ched = pages.find((p) => p.domain === 'chedraui.com.mx')!;
  assert.equal(ched.verification.status, 'uncertain');
  assert.ok(ched.verification.confidence <= 0.5);
  assert.match(ched.verification.reason, /^Not seen in search results/);
  assert.equal(pages.find((p) => p.domain === 'super.walmart.com.mx')!.verification.status, 'verified');
});

test('scan type is respected', () => {
  const answer = { pages: [page(WALMART), page(OFFICIAL, { sourceType: 'first_party' })], similarProducts: [] };
  const third = parseSearchResponse(respond(answer), req({ scanType: 'third_party' })).pages;
  assert.deepEqual(third.map((p) => p.sourceType), ['third_party']);
  const first = parseSearchResponse(respond(answer), req({ scanType: 'first_party' })).pages;
  assert.deepEqual(first.map((p) => p.domain), ['sabritas.com.mx'], 'store page dropped (and blocked) in first-party scans');
});

test('a store page Claude calls first party is still a store', () => {
  const { pages } = parseSearchResponse(respond({ pages: [page(WALMART, { sourceType: 'first_party' })], similarProducts: [] }), req());
  assert.equal(pages[0].sourceType, 'third_party');
});

test('malformed answers throw invalid_output', () => {
  for (const text of ['Sorry, here are some stores: Walmart', '{"pages": [', '{"similarProducts": []}']) {
    assert.throws(
      () => parseSearchResponse(respond(text), req()),
      (e: unknown) => e instanceof SearchError && e.code === 'invalid_output',
      text,
    );
  }
});

test('JSON in a code fence or with words around it still parses', () => {
  const json = JSON.stringify({ pages: [page(WALMART)], similarProducts: [] });
  assert.equal(parseSearchResponse(respond('```json\n' + json + '\n```'), req()).pages.length, 1);
  assert.equal(parseSearchResponse(respond(`Here you go:\n${json}\nDone.`), req()).pages.length, 1);
  assert.deepEqual(extractJson(' {"a":1} '), { a: 1 });
});

test('refusal, truncation and an unfinished pause_turn throw', () => {
  const cases: [string, string][] = [
    ['refusal', 'refusal'],
    ['max_tokens', 'truncated'],
    ['pause_turn', 'incomplete'],
  ];
  for (const [stop, code] of cases) {
    assert.throws(
      () => parseSearchResponse(respond('', [], stop), req()),
      (e: unknown) => e instanceof SearchError && e.code === code,
      stop,
    );
  }
});

test('no results → no_results with a readable message', () => {
  assert.throws(
    () => parseSearchResponse(respond({ pages: [], similarProducts: [] }), req()),
    (e: unknown) => e instanceof SearchError && e.code === 'no_results' && /Doritos Nacho/.test(e.message),
  );
  assert.throws(
    () => parseSearchResponse(respond({ pages: [page('https://www.walmart.com/x')], similarProducts: [] }), req()),
    (e: unknown) => e instanceof SearchError && e.code === 'no_results',
    'only invalid pages',
  );
});

test('seen URLs come from tool results and citations, not from Claude’s own text', () => {
  const content = [
    searchResult('https://www.soriana.com/a/'),
    { type: 'bash_code_execution_tool_result', content: { stdout: 'kept: https://heb.com.mx/b?x=1\n' } },
    { type: 'text', text: 'https://chedraui.com.mx/c', citations: [{ type: 'web_search_result_location', url: 'https://lacomer.com.mx/d' }] },
  ];
  assert.deepEqual([...collectSeenUrls(content)].sort(), ['heb.com.mx/b', 'lacomer.com.mx/d', 'soriana.com/a']);
  assert.equal(normalizeUrl('HTTPS://WWW.Soriana.com/A/?q=1#x'), 'soriana.com/A');
});

test('domain policy per scan type', () => {
  assert.ok(domainPolicy(req({ scanType: 'third_party' })).allowed?.includes('soriana.com'));
  assert.ok(!domainPolicy(req({ scanType: 'third_party' })).allowed?.some((d) => d.includes('sabritas')));
  const both = domainPolicy(req()).allowed ?? [];
  assert.ok(both.includes('sabritas.com.mx') && both.includes('doritos.com.mx') && both.includes('pepsico.com.mx'), both.join());
  assert.ok(both.length <= 64, 'API limit');
  const first = domainPolicy(req({ scanType: 'first_party' }));
  assert.equal(first.allowed, undefined);
  assert.ok(first.blocked?.includes('mercadolibre.com.mx'));
  assert.deepEqual(brandDomainGuesses({ ...doritos, brand: 'Coca-Cola', manufacturer: undefined }), ['cocacola.com.mx', 'cocacola.com', 'coca-cola.com.mx', 'coca-cola.com', 'coca.com.mx', 'coca.com']);
});

test('prompt names the product, the scan type and the search budget', () => {
  const p = buildSearchPrompt(req({ includeSimilar: true }));
  assert.match(p, /Doritos Nacho/);
  assert.match(p, /62 g/);
  assert.match(p, /7501011123588/);
  assert.match(p, /official product page/);
  assert.match(p, /Soriana/);
  assert.match(p, /2 to 4 similar products/);
  assert.match(p, /at most 8 searches/);
  assert.doesNotMatch(buildSearchPrompt(req({ scanType: 'first_party' })), /Stores to look at/);
});
