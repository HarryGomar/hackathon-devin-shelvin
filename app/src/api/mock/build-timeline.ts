// A scripted scraper build for the mock API, shaped exactly like the backend's `AgentRun`
// (backend/server/builds.py). Three outcomes: `pass` passes the gate on attempt 1; `fix` fails it on attempt 1, the
// gate's report goes back to the same session and attempt 2 passes; `fail` fails all 3 attempts (needs a person).

import type { AgentEvent, AgentProvider, AgentRun, GateAttempt, JobProgress, PageAccess } from '../types';

export type BuildOutcome = 'pass' | 'fix' | 'fail';

type Step = 'probe' | 'build' | 'gate' | 'merge';

interface Beat {
  at: number;
  kind: AgentEvent['kind'];
  stage: string;
  step: Step;
  message: string;
  /** Starts attempt n. */
  attempt?: number;
  /** Ends the current attempt with the gate's verdict. */
  verdict?: { verdict: 'pass' | 'fail'; passed: number; total: number; failed: GateAttempt['failed'] };
  state?: AgentRun['state'];
}

const WHO: Record<AgentProvider, string> = { devin: 'Devin', claude_code: 'Claude Code', scripted: 'The scripted builder', mock: 'The demo builder' };

const PRICE_FAIL: GateAttempt['failed'] = [
  { name: 'expected_values', detail: '3090610.price: 19.0 != 18.5 (read ListPrice, the page shows Price)' },
  { name: 'live_product_found', detail: 'the scanned product is not among the rows' },
];
const LAYOUT_FAIL: GateAttempt['failed'] = [
  { name: 'fixture_rows', detail: 'the saved page has 0 product rows (prices load after the page, from an API the kit has no reader for)' },
  { name: 'live_product_found', detail: 'the scanned product is not among the rows' },
];

function attemptBeats(at: number, n: number, who: string, source: string, first: boolean): Beat[] {
  const start: Beat = first
    ? { at, kind: 'system', stage: 'writing', step: 'build', message: `Attempt 1: ${who} is building the scraper`, attempt: 1, state: 'building' }
    : { at, kind: 'system', stage: 'fixing', step: 'build', message: `Attempt ${n}: the gate's report went back to the same session`, attempt: n, state: 'fixing' };
  const work: Beat[] = first
    ? [
        { at: at + 800, kind: 'agent', stage: 'writing', step: 'build', message: `Writing sources/${source}.py from the VTEX reader` },
        { at: at + 1800, kind: 'agent', stage: 'capturing', step: 'build', message: 'Capturing one real product page as the fixture' },
        { at: at + 2800, kind: 'agent', stage: 'testing', step: 'build', message: 'Fixture written; running the tests' },
      ]
    : [{ at: at + 1300, kind: 'agent', stage: 'fixing', step: 'build', message: n === 2 ? 'Price now from commertialOffer.Price; matching by EAN' : 'Trying the search API the page calls for prices' }];
  const gateAt = (work[work.length - 1]?.at ?? at) + 800;
  return [start, ...work, { at: gateAt, kind: 'system', stage: 'gate', step: 'gate', message: `Gate: the backend is checking ${source} (attempt ${n})` }];
}

function gateBeat(at: number, verdict: 'pass' | 'fail', failed: GateAttempt['failed']): Beat {
  const total = 14;
  const passed = total - failed.length;
  const message = verdict === 'pass' ? `Gate pass: ${passed}/${total} checks` : `Gate fail: ${passed}/${total} checks; failed ${failed.map((f) => f.name).join(', ')}`;
  return { at, kind: 'gate', stage: 'gate', step: 'gate', message, verdict: { verdict, passed, total, failed } };
}

function beats(domain: string, source: string, outcome: BuildOutcome, provider: AgentProvider): Beat[] {
  const who = WHO[provider];
  const out: Beat[] = [
    { at: 0, kind: 'system', stage: 'probing', step: 'probe', message: `Checking robots.txt on ${domain}` },
    { at: 700, kind: 'system', stage: 'probing', step: 'probe', message: 'Probe: reader vtex on vtex' },
  ];
  let at = 1400;
  const attempts = outcome === 'pass' ? 1 : outcome === 'fix' ? 2 : 3;
  for (let n = 1; n <= attempts; n++) {
    const work = attemptBeats(at, n, who, source, n === 1);
    out.push(...work);
    const gateAt = work[work.length - 1].at + 1000;
    const pass = outcome === 'pass' || (outcome === 'fix' && n === 2);
    out.push(gateBeat(gateAt, pass ? 'pass' : 'fail', pass ? [] : outcome === 'fix' ? PRICE_FAIL : LAYOUT_FAIL));
    at = gateAt + 700;
  }
  if (outcome === 'fail') {
    out.push({ at, kind: 'system', stage: 'done', step: 'gate', message: `The gate failed 3 attempts (fixture_rows, live_product_found); a person needs to look`, state: 'needs_person' });
  } else {
    out.push(
      { at, kind: 'system', stage: 'merging', step: 'merge', message: `Merging ${source} into the kit` },
      { at: at + 600, kind: 'system', stage: 'done', step: 'merge', message: `${source} passed the gate on attempt ${attempts} and is live; its PR merges when CI passes`, state: 'passed' },
    );
  }
  return out;
}

/** How long the scripted build runs, in ms. */
export function buildDuration(outcome: BuildOutcome) {
  const all = beats('x', 'x', outcome, 'mock');
  return all[all.length - 1].at + 400;
}

/** The run as it stands `elapsed` ms after the build started. */
export function agentRunAt(opts: {
  buildId: string;
  url: string;
  domain: string;
  kind: AgentRun['kind'];
  source: string;
  outcome: BuildOutcome;
  provider: AgentProvider;
  startedAt: number;
  elapsed: number;
  access: PageAccess;
}): { run: AgentRun; progress: JobProgress } {
  const all = beats(opts.domain, opts.source, opts.outcome, opts.provider);
  const passed = all.filter((b) => b.at <= opts.elapsed);
  const attempts: GateAttempt[] = [];
  const events: AgentEvent[] = [];
  let state: AgentRun['state'] = 'running';
  let attempt = 0;
  for (const b of passed) {
    const at = new Date(opts.startedAt + b.at).toISOString();
    if (b.attempt) {
      attempt = b.attempt;
      const previous = attempts[attempts.length - 1];
      if (previous) previous.sentBack = true;
      attempts.push({ n: b.attempt, startedAt: at, endedAt: null, outcome: null, verdict: null, passed: 0, total: 0, failed: [], sentBack: false });
    }
    if (b.verdict) {
      const current = attempts[attempts.length - 1];
      Object.assign(current, { ...b.verdict, endedAt: at, outcome: opts.provider === 'devin' ? 'pr_opened' : 'built_no_pr' });
    }
    if (b.state) state = b.state;
    events.push({
      at,
      kind: b.kind,
      stage: b.stage,
      message: b.message,
      attempt,
      ...(b.verdict ? { gate: { source: opts.source, verdict: b.verdict.verdict, passed: b.verdict.passed, total: b.verdict.total } } : {}),
    });
  }
  const last = passed[passed.length - 1] ?? all[0];
  const sessionStarted = attempt > 0;
  const merged = last.stage === 'merging' || (last.stage === 'done' && state === 'passed');
  const devin = opts.provider === 'devin';
  const run: AgentRun = {
    buildId: opts.buildId,
    provider: opts.provider,
    url: opts.url,
    domain: opts.domain,
    kind: opts.kind,
    state,
    stage: last.stage,
    note: last.message,
    source: sessionStarted ? opts.source : null,
    sessionUrl: sessionStarted && devin ? `https://app.devin.ai/sessions/mock-${opts.buildId}` : null,
    prUrl: merged && devin ? `https://github.com/HarryGomar/hackathon-devin-shelvin/pull/mock-${opts.source}` : null,
    branch: sessionStarted ? `source/${opts.source}` : null,
    access: opts.access,
    attempt,
    maxAttempts: 3,
    attempts,
    events: events.slice(-40),
    cost: !sessionStarted ? {} : devin ? { acus: Math.round(attempt * 1.4 * 10) / 10 } : { usd: Math.round(attempt * 0.42 * 100) / 100 },
    startedAt: new Date(opts.startedAt).toISOString(),
    endedAt: state === 'passed' || state === 'needs_person' ? new Date(opts.startedAt + last.at).toISOString() : null,
  };
  const steps: Step[] = ['probe', 'build', 'gate', 'merge'];
  return { run, progress: { step: last.step, message: last.message, percent: Math.round((100 * steps.indexOf(last.step)) / steps.length) } };
}
