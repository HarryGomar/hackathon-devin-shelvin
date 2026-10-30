// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentRun, GateAttempt } from '@/api/types';

import {
  attemptVerdict,
  buildEnded,
  buildRefusal,
  buildStateWord,
  buildStepStates,
  builtSummary,
  costText,
  currentBuildStep,
  domainOfUrl,
  providerLabel,
  runningSummary,
  shownBuildStep,
  siteStateWord,
  skippedBySite,
  skippedReason,
} from './build-run';

const attempt = (over: Partial<GateAttempt>): GateAttempt => ({
  n: 1,
  startedAt: '2026-10-29T06:00:00Z',
  passed: 0,
  total: 0,
  failed: [],
  sentBack: false,
  ...over,
});

const run = (over: Partial<AgentRun>): AgentRun => ({
  buildId: 'build-1',
  provider: 'devin',
  url: 'https://www.chedraui.com.mx/p/1',
  domain: 'chedraui.com.mx',
  kind: 'third_party',
  state: 'building',
  stage: 'writing',
  note: 'Writing sources/chedraui_mx.py',
  attempt: 1,
  maxAttempts: 3,
  attempts: [],
  events: [],
  startedAt: '2026-10-29T06:00:00Z',
  ...over,
});

test('provider labels name the agent; unknown providers show as sent', () => {
  assert.equal(providerLabel('devin'), 'Devin');
  assert.equal(providerLabel('claude_code'), 'Claude Code');
  assert.equal(providerLabel('scripted'), 'Scripted');
  assert.equal(providerLabel('codex'), 'codex');
  assert.equal(providerLabel(undefined), 'Agent');
});

test('state words: the run state wins, else the job status', () => {
  assert.deepEqual(buildStateWord('fixing'), { label: 'Fixing', tone: 'warning' });
  assert.deepEqual(buildStateWord('needs_person'), { label: 'Needs a person', tone: 'danger' });
  assert.equal(buildStateWord(undefined, 'succeeded').label, 'Live');
  assert.equal(buildStateWord(undefined, 'failed').label, 'Failed');
  assert.equal(buildStateWord(undefined, 'queued').label, 'Queued');
});

test('current step: the job step when it is one of the four, else from the stage', () => {
  assert.equal(currentBuildStep('gate', 'writing'), 'gate');
  assert.equal(currentBuildStep(undefined, 'capturing'), 'build');
  assert.equal(currentBuildStep('done', 'merging'), 'merge');
  assert.equal(currentBuildStep(undefined, 'something-new'), 'probe');
});

test('step states: done before, current, todo after; all done once passed; the current one failed', () => {
  assert.deepEqual(
    buildStepStates('build', undefined).map((s) => s.state),
    ['done', 'current', 'todo', 'todo'],
  );
  assert.deepEqual(
    buildStepStates('gate', 'failed').map((s) => s.state),
    ['done', 'done', 'failed', 'todo'],
  );
  assert.deepEqual(
    buildStepStates('build', 'passed').map((s) => s.state),
    ['done', 'done', 'done', 'done'],
  );
});

test('a build ends passed or failed from its state, else its job', () => {
  assert.equal(buildEnded('exists', 'running'), 'passed');
  assert.equal(buildEnded('refused', 'running'), 'failed');
  assert.equal(buildEnded('building', 'running'), undefined);
  assert.equal(buildEnded(undefined, 'succeeded'), 'passed');
});

test('attempt verdicts read as GATE PASS / GATE FAIL with the counts', () => {
  assert.deepEqual(attemptVerdict(attempt({ verdict: 'pass', passed: 14, total: 14 })), { label: 'Gate pass 14/14', tone: 'success' });
  assert.deepEqual(attemptVerdict(attempt({ verdict: 'fail', passed: 12, total: 14 })), { label: 'Gate fail 12/14', tone: 'danger' });
  assert.equal(attemptVerdict(attempt({})).label, 'Working');
  // An attempt the site blocked has ended: no spinner, and it reads as a refusal.
  assert.deepEqual(attemptVerdict(attempt({ outcome: 'blocked', endedAt: '2026-10-29T18:08:16Z' })), { label: 'blocked', tone: 'danger' });
});

test('a build that ended blocked refuses the site, though robots.txt allowed it (Soriana answered 403)', () => {
  const allowed = { status: 'allowed' as const, code: 'allowed', reason: 'robots.txt allows' };
  const refusal = buildRefusal({ state: 'blocked', note: 'soriana.com answered 403', access: allowed });
  assert.deepEqual(refusal, { status: 'refused', code: 'blocked', reason: 'soriana.com answered 403' });
  const optOut = { status: 'refused' as const, code: 'ai_opt_out', reason: 'blocks AI agents' };
  assert.equal(buildRefusal({ state: 'refused', note: '', access: optOut }), optOut);
  assert.equal(buildRefusal({ state: 'failed', note: 'gate 12/14', access: allowed }), undefined);
  assert.equal(buildRefusal(undefined), undefined);
});

test('cost: ACUs for Devin, dollars for Claude Code, nothing before a session', () => {
  assert.equal(costText({ acus: 2.8 }), '2.8 ACUs');
  assert.equal(costText({ acus: 1 }), '1 ACU');
  assert.equal(costText({ usd: 0.4 }), '$0.40');
  assert.equal(costText({}), undefined);
  assert.equal(costText(undefined), undefined);
});

test('summaries name the agent, the attempt and the gate', () => {
  const passed = run({ state: 'passed', attempt: 2, attempts: [attempt({ verdict: 'fail', passed: 12, total: 14 }), attempt({ n: 2, verdict: 'pass', passed: 14, total: 14 })] });
  assert.equal(builtSummary(passed), 'built by Devin · attempt 2 of 3 · gate 14/14');
  assert.equal(builtSummary(run({ provider: 'claude_code', state: 'exists', source: 'chedraui_mx' })), 'scraper already existed (chedraui_mx)');
  assert.equal(runningSummary(run({ provider: 'claude_code', state: 'fixing', attempt: 2 }), 'running'), 'Claude Code · attempt 2 of 3 · fixing');
  assert.equal(runningSummary(run({ state: 'queued', attempt: 0 }), 'running'), 'Devin · queued');
  assert.equal(runningSummary(undefined, 'queued'), 'queued');
});

test('skipped reasons: known codes in plain words, refusals through the failure labels', () => {
  assert.equal(skippedReason({ pageId: 'a', domain: 'x.mx', reason: 'already has a scraper' }), 'already has a scraper');
  assert.equal(skippedReason({ pageId: 'a', domain: null, reason: 'unknown page' }), 'the backend doesn’t know this page; search again');
  assert.equal(skippedReason({ pageId: 'a', domain: 'amazon.com.mx', reason: 'robots.txt blocks AI agents (ClaudeBot)', code: 'ai_opt_out' }), 'This site blocks AI agents');
  assert.equal(skippedReason({ pageId: 'a', domain: 'amazon.com.mx', reason: 'robots.txt blocks AI agents (ClaudeBot)' }), 'robots.txt blocks AI agents (ClaudeBot)');
});

test('site states during a scrape', () => {
  assert.equal(siteStateWord('fetching').label, 'Reading');
  assert.equal(siteStateWord('refused').tone, 'danger');
});

test('build domains match the backend: host, lower case, no www.', () => {
  assert.equal(domainOfUrl('https://www.Chedraui.com.mx/p/1?x=1'), 'chedraui.com.mx');
  assert.equal(domainOfUrl('http://super.walmart.com.mx:8080/ip/1'), 'super.walmart.com.mx');
});

test('skipped pages group by site and reason', () => {
  const ml = { domain: 'mercadolibre.com.mx', reason: 'robots.txt blocks AI agents' };
  const grouped = skippedBySite([
    { pageId: 'a', ...ml },
    { pageId: 'b', domain: 'soriana.com', reason: 'robots.txt answered 403' },
    { pageId: 'c', ...ml },
  ]);
  assert.deepEqual(grouped.map((k) => [k.domain, k.pages]), [['mercadolibre.com.mx', 2], ['soriana.com', 1]]);
});

test('a build that ended after a failed gate shows the failure on GATE', () => {
  const failedGate = run({ state: 'needs_person', stage: 'done', attempts: [attempt({ verdict: 'fail', passed: 25, total: 26 })] });
  assert.equal(shownBuildStep('build', failedGate, 'failed'), 'gate');
  assert.equal(shownBuildStep('build', run({ stage: 'writing', attempts: [] }), 'failed'), 'build', 'no verdict: where it stopped');
  assert.equal(shownBuildStep('gate', failedGate, undefined), 'gate');
});
