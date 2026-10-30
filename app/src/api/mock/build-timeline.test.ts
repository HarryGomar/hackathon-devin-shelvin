// Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentRunAt, buildDuration, type BuildOutcome } from './build-timeline.ts';

const at = (outcome: BuildOutcome, elapsed: number, provider: 'devin' | 'claude_code' = 'devin') =>
  agentRunAt({
    buildId: 'build-1',
    url: 'https://www.lacomer.com.mx/p/1',
    domain: 'lacomer.com.mx',
    kind: 'third_party',
    source: 'lacomer_mx',
    outcome,
    provider,
    startedAt: Date.parse('2026-10-29T06:00:00Z'),
    elapsed,
    access: { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' },
  });

test('a build starts probing, with no session yet', () => {
  const { run, progress } = at('pass', 0);
  assert.equal(progress.step, 'probe');
  assert.equal(run.attempt, 0);
  assert.equal(run.sessionUrl, null);
});

test('pass: one attempt passes the gate and goes live', () => {
  const { run, progress } = at('pass', Infinity);
  assert.equal(run.state, 'passed');
  assert.equal(progress.step, 'merge');
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].verdict, 'pass');
});

test('fix: attempt 1 fails the gate, its report goes back to the same session, attempt 2 passes', () => {
  const { run } = at('fix', Infinity);
  assert.equal(run.state, 'passed');
  assert.deepEqual(run.attempts.map((a) => a.verdict), ['fail', 'pass']);
  assert.equal(run.attempts[0].sentBack, true);
  assert.ok(run.attempts[0].failed.length > 0);
  assert.equal(run.attempt, 2);
});

test('fail: three failed gates end in needs a person, never merged', () => {
  const { run, progress } = at('fail', Infinity);
  assert.equal(run.state, 'needs_person');
  assert.equal(run.attempts.length, 3);
  assert.equal(run.prUrl, null);
  assert.equal(progress.step, 'gate');
});

test('the agent shows in the run: Devin with a session, ACUs and a PR; Claude Code with dollars and no Devin links', () => {
  const devin = at('pass', Infinity).run;
  assert.equal(devin.provider, 'devin');
  assert.ok(devin.sessionUrl);
  assert.ok(devin.prUrl);
  assert.ok(devin.cost?.acus);
  const claude = at('pass', Infinity, 'claude_code').run;
  assert.equal(claude.provider, 'claude_code');
  assert.equal(claude.sessionUrl, null);
  assert.ok(claude.cost?.usd);
  assert.match(at('pass', 1500, 'claude_code').run.note, /Claude Code/);
});

test('durations: a fix takes longer than a pass, a failure longest', () => {
  assert.ok(buildDuration('pass') < buildDuration('fix'));
  assert.ok(buildDuration('fix') < buildDuration('fail'));
});
