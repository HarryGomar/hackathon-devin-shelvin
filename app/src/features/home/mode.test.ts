// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveParts, modeStatus } from './mode';

test('modeStatus: all mocked, all live, and each mix', () => {
  assert.deepEqual(modeStatus({ apiMode: 'mock', searchMode: 'mock', identifyMode: 'mock' }), { label: 'DEMO DATA', demo: true });
  assert.deepEqual(modeStatus({ apiMode: 'live', searchMode: 'mock', identifyMode: 'live' }), { label: 'LIVE', demo: false });
  assert.equal(modeStatus({ apiMode: 'mock', searchMode: 'claude', identifyMode: 'live' }).label, 'LIVE ID · LIVE SEARCH · DEMO SCRAPERS');
  assert.equal(modeStatus({ apiMode: 'mock', searchMode: 'claude', identifyMode: 'mock' }).label, 'DEMO ID · LIVE SEARCH · DEMO SCRAPERS');
  assert.equal(modeStatus({ apiMode: 'mock', searchMode: 'mock', identifyMode: 'live' }).label, 'LIVE ID · DEMO SEARCH · DEMO SCRAPERS');
  assert.equal(modeStatus({ apiMode: 'live', searchMode: 'mock', identifyMode: 'mock' }).label, 'DEMO ID · LIVE SEARCH · LIVE SCRAPERS');
});

test('liveParts: a live backend means live search even though searchMode stays mock', () => {
  assert.equal(liveParts({ apiMode: 'live', searchMode: 'mock', identifyMode: 'mock' }).search, true);
  assert.equal(liveParts({ apiMode: 'mock', searchMode: 'mock', identifyMode: 'live' }).search, false);
  assert.equal(liveParts({ apiMode: 'mock', searchMode: 'claude', identifyMode: 'mock' }).search, true);
  assert.equal(liveParts({ apiMode: 'mock', searchMode: 'claude', identifyMode: 'mock' }).scrapers, false);
});
