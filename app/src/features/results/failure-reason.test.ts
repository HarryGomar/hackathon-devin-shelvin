// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failureReasonLabel, isBlockedCode, splitFailures } from './failure-reason';

test('robots.txt, AI opt-out and 401/403/429 (blocked) are blocked; the rest are not', () => {
  for (const c of ['ai_opt_out', 'robots_disallow', 'robots_unavailable', 'blocked']) assert.equal(isBlockedCode(c), true, c);
  for (const c of ['robots_unreachable', 'no_scraper', 'unreachable', 'parse_failed', 'not_in_catalog', 'allowed', undefined]) {
    assert.equal(isBlockedCode(c), false, String(c));
  }
});

test('labels are plain words, not the backend error', () => {
  assert.equal(failureReasonLabel('robots_disallow', 'robots.txt disallows /*/p'), "robots.txt doesn't allow scraping this page");
  assert.equal(failureReasonLabel('ai_opt_out', 'Not collected: robots.txt blocks AI agents (ClaudeBot)'), 'This site blocks AI agents');
  assert.equal(failureReasonLabel('blocked', 'site answered 403'), 'The site refused our requests');
  assert.equal(failureReasonLabel('unreachable', 'Timed out after 20 s'), "Couldn't load the page");
});

test('no code, or a code this app does not know → the backend text as is, never guessed as blocked', () => {
  assert.equal(failureReasonLabel(undefined, 'Unknown page'), 'Unknown page');
  assert.equal(failureReasonLabel('geo_blocked', 'Not available in your country'), 'Not available in your country');
  assert.equal(isBlockedCode('geo_blocked'), false);
});

test('splitFailures keeps each group in order', () => {
  const failures = [{ pageId: 'a', code: 'unreachable' }, { pageId: 'b', code: 'ai_opt_out' }, { pageId: 'c' }, { pageId: 'd', code: 'blocked' }];
  const { blocked, failed } = splitFailures(failures);
  assert.deepEqual(blocked.map((f) => f.pageId), ['b', 'd']);
  assert.deepEqual(failed.map((f) => f.pageId), ['a', 'c']);
});

test('rate_limited is temporary: retryable (Couldn\u2019t fetch), never blocked', () => {
  assert.equal(isBlockedCode('rate_limited'), false);
  assert.equal(failureReasonLabel('rate_limited', '429 Too Many Requests'), 'The site asked us to slow down; try again later');
  const { blocked, failed } = splitFailures([{ pageId: 'a', code: 'rate_limited' }, { pageId: 'b', code: 'blocked' }]);
  assert.deepEqual(failed.map((f) => f.pageId), ['a']);
  assert.deepEqual(blocked.map((f) => f.pageId), ['b']);
});
