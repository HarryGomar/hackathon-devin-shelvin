// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentEvent, AgentRun, GateAttempt, GateReport } from '@/api/types';

import {
  anyActive,
  buildMeta,
  clockTime,
  costText,
  durationText,
  eventTag,
  eventTone,
  gateSummary,
  isActive,
  kindTag,
  lastGated,
  lastGateIndex,
  outcomeText,
  stateWord,
  verdictWord,
  whenLine,
} from './format';
import { strings } from './strings';

const attempt = (over: Partial<GateAttempt>): GateAttempt => ({
  n: 1,
  startedAt: '2026-10-29T12:00:00Z',
  endedAt: null,
  outcome: null,
  verdict: null,
  passed: 0,
  total: 0,
  failed: [],
  sentBack: false,
  ...over,
});

const run = (over: Partial<AgentRun>): AgentRun => ({
  buildId: 'job-1',
  provider: 'devin',
  url: 'https://www.lacomer.com.mx/p/1',
  domain: 'lacomer.com.mx',
  kind: 'third_party',
  state: 'building',
  stage: 'writing',
  note: '',
  attempt: 1,
  maxAttempts: 3,
  attempts: [],
  events: [],
  startedAt: '2026-10-29T12:00:00Z',
  ...over,
});

const event = (over: Partial<AgentEvent>): AgentEvent => ({ at: '2026-10-29T12:00:00Z', kind: 'system', stage: 'probing', message: '', attempt: 0, ...over });

test('active states: queued and the builder working; everything else has ended', () => {
  for (const s of ['queued', 'running', 'building', 'fixing'] as const) assert.equal(isActive(s), true, s);
  for (const s of ['passed', 'exists', 'failed', 'refused', 'blocked', 'unreachable', 'needs_person'] as const) assert.equal(isActive(s), false, s);
  assert.equal(anyActive([{ state: 'passed' }, { state: 'fixing' }]), true);
  assert.equal(anyActive([{ state: 'passed' }, { state: 'refused' }]), false);
  assert.equal(anyActive([]), false);
});

test('state words: label and tone per state, unknown states as is', () => {
  assert.deepEqual(stateWord('passed'), { label: strings.states.passed, tone: 'success' });
  assert.deepEqual(stateWord('needs_person'), { label: 'Needs person', tone: 'warning' });
  assert.equal(stateWord('refused').tone, 'danger');
  assert.equal(stateWord('building').tone, 'accent');
  assert.deepEqual(stateWord('paused' as never), { label: 'paused', tone: 'neutral' });
});

test('duration: seconds, minutes, hours; to now while running; undefined for bad dates', () => {
  const start = '2026-10-29T12:00:00Z';
  assert.equal(durationText(start, '2026-10-29T12:00:42Z'), '42s');
  assert.equal(durationText(start, '2026-10-29T12:03:05Z'), '3m 05s');
  assert.equal(durationText(start, '2026-10-29T13:02:30Z'), '1h 02m');
  assert.equal(durationText(start, null, Date.parse('2026-10-29T12:00:09.6Z')), '10s');
  assert.equal(durationText(start, '2026-10-29T11:59:00Z'), '0s', 'clock skew never goes negative');
  assert.equal(durationText('not a date', null), undefined);
  assert.equal(durationText(undefined, null), undefined);
});

test('clock time: HH:MM:SS in local time', () => {
  assert.equal(clockTime(new Date(2026, 9, 29, 9, 5, 7).toISOString()), '09:05:07');
  assert.equal(clockTime('nope'), '--:--:--');
});

test('when line: start and duration', () => {
  const line = whenLine({ startedAt: '2026-10-29T12:00:00Z', endedAt: '2026-10-29T12:01:12Z' });
  assert.ok(line.endsWith(' · 1m 12s'), line);
  assert.equal(whenLine({ startedAt: 'bad', endedAt: null }), '');
});

test('kind tags and trace tags', () => {
  assert.equal(kindTag('system'), 'backend');
  assert.equal(kindTag('agent'), 'builder');
  assert.equal(kindTag('agent_gate'), 'builder gate');
  assert.equal(kindTag('gate'), 'gate');
  assert.equal(eventTag(event({ kind: 'agent', stage: 'writing' })), 'BUILDER · WRITING');
  assert.equal(eventTag(event({ kind: 'gate', stage: '' })), 'GATE');
});

test('trace tone: the gate verdict when the line has one', () => {
  const gate = (verdict: string) => ({ source: 'lacomer_mx', verdict, passed: 1, total: 2 });
  assert.equal(eventTone(event({ kind: 'gate', gate: gate('pass') })), 'success');
  assert.equal(eventTone(event({ kind: 'gate', gate: gate('fail') })), 'danger');
  assert.equal(eventTone(event({ kind: 'gate', gate: gate('unreachable') })), 'warning');
  assert.equal(eventTone(event({ kind: 'system' })), 'neutral');
  assert.equal(eventTone(event({ kind: 'agent_gate' })), 'accent');
});

test('cost: ACUs and dollars when present', () => {
  assert.equal(costText({ acus: 2.8 }), '2.8 ACU');
  assert.equal(costText({ usd: 1.2 }), '$1.20');
  assert.equal(costText({ acus: 3.14159, usd: 0.5 }), '3.14 ACU · $0.50');
  assert.equal(costText({}), undefined);
  assert.equal(costText(undefined), undefined);
});

test('build meta: builder, attempt, latest gate, cost', () => {
  const attempts = [attempt({ n: 1, verdict: 'fail', passed: 12, total: 14 }), attempt({ n: 2 })];
  assert.equal(lastGated({ attempts })?.n, 1, 'attempt 2 has no verdict yet');
  assert.equal(buildMeta(run({ attempt: 2, attempts, cost: { acus: 2.8 } })), 'Devin · attempt 2/3 · gate 12/14 · 2.8 ACU');
  assert.equal(buildMeta(run({ provider: 'mock', attempt: 0, maxAttempts: 0, state: 'refused' })), 'Mock', 'refused: no builder ran');
});

test('verdict words: gated, working, or no gate', () => {
  assert.deepEqual(verdictWord(attempt({ verdict: 'pass' }), false), { label: 'Pass', tone: 'success' });
  assert.equal(verdictWord(attempt({ verdict: 'fail' }), true).tone, 'danger');
  assert.equal(verdictWord(attempt({}), true).label, strings.verdicts.working);
  assert.equal(verdictWord(attempt({}), false).label, strings.verdicts.none, 'the build ended without gating it');
  assert.equal(verdictWord(attempt({ endedAt: '2026-10-29T12:05:00Z' }), true).label, strings.verdicts.none);
});

test('outcome text: known codes, unknown ones with spaces', () => {
  assert.equal(outcomeText('pr_opened'), 'PR opened');
  assert.equal(outcomeText('tests_failed'), 'tests failed');
  assert.equal(outcomeText(null), strings.noOutcome);
});

test('gate summary and the gate that starts open', () => {
  const report: GateReport = {
    source: 'lacomer_mx',
    verdict: 'fail',
    rows: 32,
    checks: [
      { name: 'source_loads', passed: true, detail: 'ok' },
      { name: 'expected_values', passed: false, detail: 'price 19.0 != 18.5' },
    ],
  };
  assert.equal(gateSummary(report), 'fail · 1/2 · lacomer_mx · 32 rows');
  assert.equal(gateSummary({ ...report, source: null, rows: null as never }), 'fail · 1/2');
  assert.equal(lastGateIndex([report, null]), 0);
  assert.equal(lastGateIndex([report, null, report]), 2);
  assert.equal(lastGateIndex([null]), -1);
  assert.equal(lastGateIndex(undefined), -1);
});
