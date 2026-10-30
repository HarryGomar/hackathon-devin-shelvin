// Run: npm test  (node --test with native TypeScript stripping; no network)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentRun, PageAccess } from '../types.ts';

import { buildDetail, buildHistory, GATE_CHECKS, gateReportFor } from './build-history.ts';
import { agentRunAt } from './build-timeline.ts';

const ALLOWED: PageAccess = { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' };
const T0 = Date.parse('2026-10-29T12:00:00Z');

const timeline = (buildId: string, domain: string, minutesAfter: number, elapsed: number, flaky = false) =>
  agentRunAt({ buildId, url: `https://${domain}/p/1`, domain, kind: 'third_party', source: 'x_mx', outcome: flaky ? 'fix' : 'pass', provider: 'mock', startedAt: T0 + minutesAfter * 60_000, elapsed, access: ALLOWED }).run;

const refused = (buildId: string, domain: string, minutesAfter: number): AgentRun => {
  const at = new Date(T0 + minutesAfter * 60_000).toISOString();
  return { ...timeline(buildId, domain, minutesAfter, 0), state: 'refused', attempt: 0, maxAttempts: 0, source: null, events: [], startedAt: at, endedAt: at };
};

test('history: newest first, five events each, a tally per site and the totals', () => {
  const runs = [
    timeline('a', 'soriana.com', 0, Infinity),
    timeline('b', 'lacomer.com.mx', 10, Infinity, true),
    refused('c', 'amazon.com.mx', 20),
    timeline('d', 'lacomer.com.mx', 30, 3000),
  ];
  const history = buildHistory(runs);
  assert.deepEqual(history.builds.map((r) => r.buildId), ['d', 'c', 'b', 'a']);
  assert.ok(history.builds.every((r) => r.events.length <= 5));
  assert.equal(runs[1].events.length > 5, true, 'the recorded run keeps every event');
  assert.deepEqual(history.totals, { builds: 4, passed: 2, failed: 0, refused: 1, running: 1 });
  assert.equal(history.running, 1);
  assert.equal(history.parallel, 4);

  assert.deepEqual(history.sites.map((s) => s.domain), ['lacomer.com.mx', 'amazon.com.mx', 'soriana.com']);
  const lacomer = history.sites[0];
  assert.deepEqual(
    { builds: lacomer.builds, passed: lacomer.passed, failed: lacomer.failed, refused: lacomer.refused, lastState: lacomer.lastState, lastBuildId: lacomer.lastBuildId },
    { builds: 2, passed: 1, failed: 0, refused: 0, lastState: 'building', lastBuildId: 'd' },
  );
  assert.equal(lacomer.source, 'x_mx');
  assert.equal(history.sites[1].refused, 1);
  assert.equal(history.sites[1].source, null);
});

test('history: domain, state and limit filter the builds, not the tally', () => {
  const runs = [timeline('a', 'soriana.com', 0, Infinity), timeline('b', 'lacomer.com.mx', 10, Infinity), refused('c', 'amazon.com.mx', 20)];
  assert.deepEqual(buildHistory(runs, { domain: 'soriana.com' }).builds.map((r) => r.buildId), ['a']);
  assert.deepEqual(buildHistory(runs, { state: 'refused' }).builds.map((r) => r.buildId), ['c']);
  assert.deepEqual(buildHistory(runs, { limit: 2 }).builds.map((r) => r.buildId), ['c', 'b']);
  assert.equal(buildHistory(runs, { domain: 'soriana.com' }).sites.length, 3);
  assert.deepEqual(buildHistory([]), { builds: [], sites: [], totals: { builds: 0, passed: 0, failed: 0, refused: 0, running: 0 }, running: 0, parallel: 4 });
});

test('gate report per attempt: the failed checks as recorded, the rest passing; null before the gate', () => {
  const run = timeline('b', 'lacomer.com.mx', 0, Infinity, true);
  const [first, second] = buildDetail(run).gates;
  assert.ok(first && second);
  assert.equal(first.verdict, 'fail');
  assert.equal(first.checks.length, 14);
  assert.deepEqual(first.checks.filter((c) => !c.passed).map((c) => c.name), ['expected_values', 'live_product_found']);
  assert.match(first.checks.find((c) => c.name === 'expected_values')!.detail, /ListPrice/);
  assert.equal(second.verdict, 'pass');
  assert.ok(second.checks.every((c) => c.passed));
  assert.deepEqual(second.checks.map((c) => c.name), GATE_CHECKS);

  assert.equal(gateReportFor({ n: 1, startedAt: '', passed: 0, total: 0, failed: [], sentBack: false, verdict: null }, 'x_mx'), null);
  const odd = gateReportFor({ n: 1, startedAt: '', passed: 2, total: 3, failed: [{ name: 'new_check', detail: 'd' }], sentBack: false, verdict: 'fail' }, null);
  assert.deepEqual(odd?.checks.map((c) => [c.name, c.passed]), [['source_declares', true], ['source_loads', true], ['new_check', false]]);
});

test('detail: every event, oldest first, and one gate slot per attempt', () => {
  const live = timeline('d', 'lacomer.com.mx', 0, 6500, true);
  const detail = buildDetail(live);
  assert.equal(detail.events.length, live.events.length);
  assert.equal(detail.gates.length, detail.attempts.length);
  assert.ok(detail.events.every((e, i) => i === 0 || e.at >= detail.events[i - 1].at));
});
