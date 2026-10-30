// Run: npm test  (node --test with native TypeScript stripping; no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProductIdentity, SourcePage } from '../types.ts';

import { buildListing, buildPages, PRODUCTS, refusedAccess, scrapedImageFor, scrapeFailureFor } from './fixtures.ts';

const now = new Date('2026-10-29T12:00:00Z');
const USER_PHOTO = 'file:///var/mobile/photo.jpg';

/** A page found by the live Claude search, on a known store. */
const livePage: SourcePage = {
  id: 'web-super-walmart-com-mx-1abc',
  url: 'https://super.walmart.com.mx/ip/botana-barcel-takis-fuego-80-g/00075752802604',
  domain: 'super.walmart.com.mx',
  retailerName: 'Walmart Súper',
  sourceType: 'third_party',
  title: 'Botana Barcel Takis fuego 80 g',
  matchType: 'exact',
  verification: { status: 'uncertain', confidence: 0.35, reason: '80 g pack' },
  scraper: { status: 'available', scraperId: 'scr-walmart' },
};

test('a mock listing never inherits the identity photo', () => {
  const identity: ProductIdentity = { ...PRODUCTS['takis-fuego'], id: 'takis-fuego-70-g', imageUrl: USER_PHOTO, imageSource: 'user_photo' };
  assert.equal(buildListing(livePage, identity, now).imageUrl, undefined, 'live third-party page → no image');
  assert.equal(buildListing({ ...livePage, id: 'web-barcel-com-mx-2def', sourceType: 'first_party' }, identity, now).imageUrl, undefined, 'live official page → no image');
  assert.equal(buildListing({ ...livePage, id: 'user--https-example-com-x' }, identity, now).imageUrl, undefined, 'page added by the user → no image');
});

test('fixture pages carry their own "scraped" image, whatever the identity photo is', () => {
  const identity: ProductIdentity = { ...PRODUCTS['doritos-incognita'], imageUrl: USER_PHOTO };
  for (const page of buildPages(identity, 'both', false)) {
    const listing = buildListing(page, identity, now);
    assert.notEqual(listing.imageUrl, USER_PHOTO, page.id);
    assert.equal(listing.imageUrl, scrapedImageFor(page), page.id);
    assert.match(listing.imageUrl ?? '', /^https:\/\/images\.openfoodfacts\.org\//, page.id);
  }
});

test('a fixture product without a scraped image gets none (initials in the UI)', () => {
  const page = buildPages(PRODUCTS['doritos-flamin-hot'], 'third_party', false)[0];
  assert.equal(buildListing(page, PRODUCTS['doritos-flamin-hot'], now).imageUrl, undefined);
});

test('Amazon and Mercado Libre refuse collection (AI-agent opt-out, as the kit finds); the rest are allowed', () => {
  const pages = buildPages(PRODUCTS['doritos-incognita'], 'both', false);
  const byDomain = (d: string) => pages.find((p) => p.domain === d)!;
  for (const d of ['amazon.com.mx', 'mercadolibre.com.mx']) {
    assert.equal(byDomain(d).access?.status, 'refused', d);
    assert.equal(byDomain(d).access?.code, 'ai_opt_out', d);
    assert.ok(byDomain(d).access?.alternative, `${d} names an official alternative`);
    assert.notEqual(byDomain(d).scraper.status, 'available', `${d} has no scraper`);
  }
  assert.equal(byDomain('super.walmart.com.mx').access?.status, 'allowed');
  assert.equal(refusedAccess('amazon.com.mx')?.code, 'ai_opt_out', 'any Amazon URL, live search or pasted');
  assert.equal(refusedAccess('soriana.com'), undefined);
});

test('scrape failures carry a code: HEB blocked (403), Bodega Aurrera unreachable', () => {
  const pages = buildPages(PRODUCTS['doritos-incognita'], 'third_party', false);
  assert.equal(scrapeFailureFor(pages.find((p) => p.domain === 'heb.com.mx')!)?.code, 'blocked');
  assert.equal(scrapeFailureFor(pages.find((p) => p.domain === 'despensa.bodegaaurrera.com.mx')!)?.code, 'unreachable');
  assert.equal(scrapeFailureFor(pages.find((p) => p.domain === 'soriana.com')!), undefined);
});

test('the made-up HEB block is never claimed for a real page; the timeout stays on every page, as before', () => {
  const live = (domain: string): SourcePage => ({ ...livePage, id: `web-${domain}-1`, domain, url: `https://${domain}/x` });
  assert.equal(scrapeFailureFor(live('heb.com.mx')), undefined);
  assert.equal(scrapeFailureFor(live('despensa.bodegaaurrera.com.mx'))?.code, 'unreachable');
});
