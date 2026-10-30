// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Listing } from '@/api/types';

import { findListing, savedPageIds } from './listing-lookup';

const listing = (id: string, pageId: string, title = id): Listing => ({
  id,
  pageId,
  url: `https://example.com/${pageId}`,
  domain: 'example.com',
  retailerName: 'Example',
  title,
  fields: {},
  scrapedAt: '2026-10-28T14:05:00.000Z',
});

test('findListing: first list that has the id wins', () => {
  const fresh = [listing('a', 'p1', 'fresh')];
  const saved = [listing('a', 'p1', 'saved'), listing('b', 'p2')];
  assert.equal(findListing('a', fresh, saved)?.title, 'fresh');
  assert.equal(findListing('b', fresh, saved)?.id, 'b');
});

test('findListing: missing lists and unknown ids give undefined', () => {
  assert.equal(findListing('a', undefined, undefined), undefined);
  assert.equal(findListing('zzz', [listing('a', 'p1')]), undefined);
  assert.equal(findListing('a'), undefined);
});

test('savedPageIds: one per page, in order', () => {
  assert.deepEqual(savedPageIds([listing('a', 'p1'), listing('b', 'p2'), listing('c', 'p1')]), ['p1', 'p2']);
  assert.deepEqual(savedPageIds([]), []);
});
