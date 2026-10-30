// The mock's console: a small deterministic story of builds people can steer, and what follows each action.
// A record is the scripted run plus what happened later (person events, Devin's replies, a stop, a manual gate), each
// from its own time on, so `viewRun(record, now)` is the build as GET /builds/:id would send it at `now`.

import { ApiError } from '../http';
import type {
  AgentEvent,
  AgentProvider,
  AgentRun,
  BuildChanges,
  BuildControls,
  BuildMessageRequest,
  BuildState,
  ChangedFile,
  Decision,
  DecisionCard,
  DecisionLibrary,
  DecisionRequest,
  DecisionResult,
  GateAttempt,
  GateCheck,
  PageAccess,
  ReaderPerformance,
  SessionInsights,
} from '../types';
import { GATE_CHECKS, gateReportFor } from './build-history';

/** Something that happens from `at` (ms) on: an event added, fields of the run changed, a decision recorded. */
export interface Later {
  at: number;
  event?: AgentEvent;
  patch?: Partial<AgentRun>;
  decision?: Decision;
}

export interface ConsoleRecord {
  /** The scripted run at `now` (a story build is fixed; one started in the app follows its timeline). */
  base: (now: number) => AgentRun;
  later: Later[];
  /** The script stops here (a stop took effect). */
  stoppedAt?: number;
  /** Decisions recorded with the script, every version, oldest first. */
  decisions: Decision[];
  /** Decisions from similar builds the builder was given. */
  reused?: Decision[];
  reader?: string | null;
  /** When someone asked Devin for insights; `ready`: they were generated before the console opened. */
  insightsAt?: number | null;
  insightsReady?: boolean;
}

const ACTIVE: BuildState[] = ['queued', 'running', 'building', 'fixing'];
const INSIGHTS_MS = 4000;
const REPLY_MS = 2500;
const STOP_MS = 1500;
const GATE_MS = 3000;

const iso = (ms: number) => new Date(ms).toISOString();

export function record(base: (now: number) => AgentRun, extra: Partial<ConsoleRecord> = {}): ConsoleRecord {
  return { base, later: [], decisions: [], ...extra };
}

/** The build at `now`: the script (up to a stop), then everything due from `later`, events oldest first. */
export function viewRun(rec: ConsoleRecord, now: number): AgentRun {
  const run = rec.base(rec.stoppedAt !== undefined ? Math.min(now, rec.stoppedAt) : now);
  let out: AgentRun = { ...run, events: [...run.events] };
  for (const l of rec.later) {
    if (l.at > now) continue;
    if (l.event) out.events.push(l.event);
    if (l.patch) out = { ...out, ...l.patch, events: out.events };
  }
  out.events.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/** The build's decisions as they stand at `now`: the latest version per topic, in the order topics first appeared. */
export function decisionsAt(rec: ConsoleRecord, now: number): Decision[] {
  const all = [...rec.decisions, ...rec.later.filter((l) => l.decision && l.at <= now).map((l) => l.decision!)].filter((d) => Date.parse(d.at) <= now);
  const byTopic = new Map<string, Decision>();
  for (const d of all) byTopic.set(d.topic, d);
  return [...byTopic.values()];
}

/** A gate run someone asked for and no manual gate result after it yet. */
export function gatePending(events: AgentEvent[]) {
  let asked = -1;
  events.forEach((e, i) => {
    if (e.kind === 'person' && e.stage === 'gate') asked = i;
  });
  return asked >= 0 && !events.slice(asked + 1).some((e) => e.kind === 'gate' && e.gate?.manual);
}

/** What the console may do now, as the backend would decide it. */
export function controlsFor(run: AgentRun, decisions: Decision[]): BuildControls {
  const yes = { ok: true };
  const no = (why: string) => ({ ok: false, why });
  const active = ACTIVE.includes(run.state);
  const live = active && run.live !== false;
  const cutOff = active && run.live === false;
  const devin = run.provider === 'devin' && !!run.sessionUrl;
  return {
    message: live && devin
      ? yes
      : !devin
        ? no('No Devin session to message.')
        : cutOff
          ? no('The backend restarted and lost this session. Start another attempt with your note.')
          : no('The build has ended. Start another attempt with your note.'),
    stop: live ? yes : cutOff ? no('Nothing is running it since the backend restarted.') : no('It has already ended.'),
    retry:
      run.state === 'refused'
        ? no('The site refuses automated collection.')
        : run.state === 'passed' || run.state === 'exists'
          ? no('It passed; nothing to retry.')
          : live
            ? no('It is still running. Stop it first.')
            : yes,
    gate: !run.source ? no('No source written yet.') : gatePending(run.events) ? no('A gate run is already going.') : yes,
    changes: run.source ? yes : no("The builder hasn't changed anything yet."),
    insights: devin ? yes : no('Insights come from a Devin session; this build had none.'),
    decide: run.state === 'refused' ? no('No builder ran.') : decisions.length ? yes : no('No decisions recorded yet.'),
  };
}

function check(controls: BuildControls, key: keyof BuildControls) {
  const c = controls[key];
  if (!c.ok) throw new ApiError(c.why ?? 'Not possible now.', 409, 'not_available');
}

function personEvent(run: AgentRun, now: number, stage: string, message: string, by?: string, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { at: iso(now), kind: 'person', stage, message, attempt: run.attempt, by: by || 'Someone', ...extra };
}

function replyFor(req: BuildMessageRequest, run: AgentRun): string {
  const c = req.context;
  if (c?.kind === 'line') return `Looking at ${c.path}:${c.line} now; I'll change it and rerun the tests.`;
  if (c?.kind === 'check') return `Re-reading ${c.name}: I'll fix what it found and run the gate again.`;
  if (run.question) return 'Thanks, that answers it. Carrying on with that.';
  return "Got it. I'll take that into account and report back in the trace.";
}

/** POST /builds/:id/messages */
export function postMessage(rec: ConsoleRecord, req: BuildMessageRequest, now: number): AgentEvent {
  const run = viewRun(rec, now);
  check(controlsFor(run, decisionsAt(rec, now)), 'message');
  const event = personEvent(run, now, 'message', req.message, req.by, req.context ? { context: req.context } : {});
  rec.later.push({ at: now, event, patch: { question: null } });
  rec.later.push({ at: now + REPLY_MS, event: { at: iso(now + REPLY_MS), kind: 'agent', stage: run.stage, message: replyFor(req, run), attempt: run.attempt } });
  return event;
}

/** POST /builds/:id/stop: the request now, 'stopped' a moment later (the backend's thread notices). */
export function postStop(rec: ConsoleRecord, by: string | undefined, now: number): AgentRun {
  const run = viewRun(rec, now);
  check(controlsFor(run, decisionsAt(rec, now)), 'stop');
  rec.later.push({ at: now, event: personEvent(run, now, 'stop', 'Stop requested', by) });
  const at = now + STOP_MS;
  rec.stoppedAt = at;
  rec.later.push({
    at,
    event: { at: iso(at), kind: 'system', stage: 'done', message: `Stopped from the console by ${by || 'someone'}`, attempt: run.attempt },
    patch: { state: 'stopped', stage: 'done', note: 'Stopped from the console', endedAt: iso(at), question: null },
  });
  return viewRun(rec, now);
}

/** The checks a manual gate finds: the last gate's report when it failed, all passing once passed, no fixture before. */
function manualChecks(run: AgentRun): GateCheck[] {
  const last = [...run.attempts].reverse().find((a) => a.verdict);
  if (last) return gateReportFor(last, run.source ?? null)!.checks;
  const missing = new Map([
    ['fixture_exists', 'no fixture saved yet under fixtures/'],
    ['expected_written', 'expected.json not written yet'],
  ]);
  return GATE_CHECKS.map((name) => ({ name, passed: !missing.has(name), detail: missing.get(name) ?? 'ok' }));
}

/** POST /builds/:id/gate: the request event now, the manual gate's result a few seconds later. */
export function postGate(rec: ConsoleRecord, by: string | undefined, now: number): AgentEvent {
  const run = viewRun(rec, now);
  check(controlsFor(run, decisionsAt(rec, now)), 'gate');
  const event = personEvent(run, now, 'gate', 'Gate run requested (checks only, never merges)', by);
  rec.later.push({ at: now, event });
  const checks = manualChecks(run);
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  const verdict = failed.length ? 'fail' : 'pass';
  const at = now + GATE_MS;
  rec.later.push({
    at,
    event: {
      at: iso(at),
      kind: 'gate',
      stage: 'gate',
      message: failed.length ? `Manual gate fail: ${passed}/${checks.length} checks; failed ${failed.join(', ')}` : `Manual gate pass: ${passed}/${checks.length} checks`,
      attempt: run.attempt,
      gate: { source: run.source ?? null, verdict, passed, total: checks.length, manual: true, checks },
    },
  });
  return event;
}

/** POST /builds/:id/retry: a note on this build, and a new build that continues it and passes a few seconds later. */
export function postRetry(rec: ConsoleRecord, req: { message: string; by?: string }, newId: string, now: number): { record: ConsoleRecord; sameSession: boolean } {
  const old = viewRun(rec, now);
  check(controlsFor(old, decisionsAt(rec, now)), 'retry');
  const sameSession = !!old.sessionUrl && old.live !== false;
  rec.later.push({ at: now, event: personEvent(old, now, 'retry', req.message, req.by) });
  rec.later.push({ at: now, event: { at: iso(now), kind: 'system', stage: 'done', message: `Another attempt started from the console: ${newId}`, attempt: old.attempt } });
  const source = old.source ?? `${old.domain.split('.')[0]}_mx`;
  const attempt: GateAttempt = { n: 1, startedAt: iso(now), endedAt: null, outcome: null, verdict: null, passed: 0, total: 0, failed: [], sentBack: false };
  const start: AgentRun = {
    ...old,
    buildId: newId,
    state: 'fixing',
    stage: 'fixing',
    note: sameSession ? 'Continuing in the same Devin session with your note' : 'A fresh session with your note',
    attempt: 1,
    maxAttempts: 3,
    attempts: [attempt],
    events: [
      {
        at: iso(now),
        kind: 'system',
        stage: 'fixing',
        message: `Continues ${old.buildId}${sameSession ? ' in the same Devin session' : ' in a fresh session'}. Note from ${req.by || 'someone'}: ${req.message}`,
        attempt: 1,
      },
    ],
    cost: { acus: 0.4 },
    startedAt: iso(now),
    endedAt: null,
    prUrl: null,
    question: null,
    continues: old.buildId,
    live: true,
    source,
  };
  const next = record(() => start, { decisions: decisionsAt(rec, now).map((d) => ({ ...d, buildId: newId })), reader: rec.reader });
  const ev = (ms: number, kind: AgentEvent['kind'], stage: string, message: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
    at: iso(now + ms),
    kind,
    stage,
    message,
    attempt: 1,
    ...extra,
  });
  const done = (ms: number, verdict: GateAttempt['verdict']): GateAttempt => ({ ...attempt, endedAt: iso(now + ms), verdict, passed: 14, total: 14, outcome: 'pr_opened' });
  next.later.push(
    { at: now + 2000, event: ev(2000, 'agent', 'fixing', 'Read the note; changing the source to match it') },
    { at: now + 5000, event: ev(5000, 'system', 'gate', `Gate: the backend is checking ${source} (attempt 1)`), patch: { stage: 'gate' } },
    {
      at: now + 7000,
      event: ev(7000, 'gate', 'gate', 'Gate pass: 14/14 checks', { gate: { source, verdict: 'pass', passed: 14, total: 14 } }),
      patch: { attempts: [done(7000, 'pass')], cost: { acus: 1.1 } },
    },
    { at: now + 8000, event: ev(8000, 'system', 'merging', `Merging ${source} into the kit`), patch: { stage: 'merging' } },
    {
      at: now + 9000,
      event: ev(9000, 'system', 'done', `${source} passed the gate on attempt 1 and is live`),
      patch: { state: 'passed', stage: 'done', note: `${source} passed the gate on attempt 1 and is live`, endedAt: iso(now + 9000), prUrl: `https://github.com/HarryGomar/hackathon-devin-shelvin/pull/mock-${source}` },
    },
  );
  return { record: next, sameSession };
}

/** POST /builds/:id/decisions: confirm or change; a change on a live build goes to Devin, who answers. */
export function postDecision(rec: ConsoleRecord, buildId: string, req: DecisionRequest, now: number): DecisionResult {
  const run = viewRun(rec, now);
  const current = decisionsAt(rec, now);
  check(controlsFor(run, current), 'decide');
  const cur = current.find((d) => d.topic === req.topic);
  if (!cur) throw new ApiError(`No decision on ${req.topic}`, 404, 'not_found');
  const change = req.action === 'change' && !!req.choice && req.choice !== cur.choice;
  const decision: Decision = {
    ...cur,
    buildId,
    at: iso(now),
    status: change ? 'changed' : 'confirmed',
    choice: change ? req.choice! : cur.choice,
    alternatives: change ? [cur.choice, ...cur.alternatives.filter((a) => a !== req.choice)] : cur.alternatives,
    why: req.why?.trim() || cur.why,
    by: req.by || 'Someone',
  };
  const card: DecisionCard = { topic: decision.topic, choice: decision.choice, why: decision.why, alternatives: decision.alternatives, status: decision.status, by: decision.by };
  const live = ACTIVE.includes(run.state) && run.live !== false;
  const sentToBuilder = change && live;
  rec.later.push({
    at: now,
    decision,
    event: { at: iso(now), kind: 'decision', stage: run.stage, message: `${change ? 'Changed' : 'Confirmed'} by ${decision.by}: ${decision.choice}`, attempt: run.attempt, decision: card },
  });
  if (sentToBuilder) {
    rec.later.push({
      at: now + REPLY_MS,
      event: { at: iso(now + REPLY_MS), kind: 'agent', stage: run.stage, message: `Switching ${decision.topic} to ${decision.choice}; redoing what depends on it`, attempt: run.attempt },
    });
  }
  return { decision, sentToBuilder };
}

/** GET /builds/:id/insights: none until asked, then started for a few seconds, then Devin's analysis. */
export function insightsAt(rec: ConsoleRecord, now: number): SessionInsights {
  const run = viewRun(rec, now);
  const empty: SessionInsights = { sessionUrl: run.sessionUrl ?? null, status: null, issues: [], actionItems: [], skillUsage: { good: [], bad: [] }, suggestedPrompt: null, timeline: [] };
  const asked = rec.insightsAt;
  if (!rec.insightsReady && (asked === undefined || asked === null)) return empty;
  if (!rec.insightsReady && now - asked! < INSIGHTS_MS) return { ...empty, status: 'started' };
  return cannedInsights(run);
}

function cannedInsights(run: AgentRun): SessionInsights {
  const source = run.source ?? run.domain;
  const failed = run.attempts.filter((a) => a.verdict === 'fail').length;
  return {
    sessionUrl: run.sessionUrl ?? null,
    status: 'completed',
    size: failed > 1 ? 'l' : 'm',
    acus: run.cost?.acus ?? null,
    messages: { user: 2 + run.events.filter((e) => e.kind === 'person').length, devin: 14 + 6 * run.attempt },
    issues: failed
      ? [
          {
            label: 'price',
            title: 'Read the struck-out price',
            issue: `The first attempt read ListPrice for ${source}; the page shows Price.`,
            impact: `Cost ${failed} failed gate run${failed === 1 ? '' : 's'} (expected_values).`,
          },
          { label: 'fixture', title: 'Saved a page without prices', issue: 'Prices load after the page from an API the kit had no reader for.', impact: 'fixture_rows found 0 product rows.' },
        ]
      : [{ label: 'pacing', title: 'Waited longer than needed', issue: 'Slept 5 s between requests where robots.txt asks for 2 s.', impact: 'About 2 minutes of idle session time.' }],
    actionItems: [
      { type: 'skill', item: 'build-source: say which VTEX price field the page shows (Price, not ListPrice).' },
      { type: 'prompt', item: 'Give the builder the saved decisions of the last passed build with the same reader.' },
    ],
    skillUsage: {
      good: [{ skill: 'build-source', reason: 'Followed the two-path rule: only sources/ and fixtures/ changed.' }],
      bad: failed ? [{ skill: 'build-source', reason: 'Skipped the price check against the live page before the gate.' }] : [],
    },
    suggestedPrompt: {
      original: `Build a scraper source for ${run.domain} with the kit. Pass the gate.`,
      suggested: `Build a scraper source for ${run.domain} with the kit's VTEX reader. Read commertialOffer.Price (the price the page shows), find the product by EAN, keep to 1 request every 2 s, and run the gate before you open a PR.`,
      feedback: [
        { summary: 'Name the reader', details: 'The probe already knows it; saying it saves the first exploration.' },
        { summary: 'Say which price', details: 'Two of three failed gates came from reading the wrong price field.' },
      ],
    },
    timeline: [
      { title: 'Probe read', description: 'Read the probe and picked the reader.' },
      { title: 'Source written', description: `Wrote sources/${source}.py from the reader.` },
      { title: 'Fixture captured', description: 'Saved one real product page and expected.json.' },
      ...(failed ? [{ title: 'Gate failed', description: `Fixed after the gate's report (${failed}×).` }] : []),
      { title: run.state === 'passed' ? 'Gate passed' : 'Waiting', description: run.state === 'passed' ? 'Opened the PR; it merges when CI passes.' : run.note },
    ],
  };
}

/** GET /builds/:id/changes: the builder's two paths against main. Null when nothing was written. */
export function changesFor(run: AgentRun, priceField = 'commertialOffer.Price'): BuildChanges | null {
  const source = run.source;
  if (!source) return null;
  const sourceFile: ChangedFile = {
    path: `sources/${source}.py`,
    status: 'added',
    additions: 14,
    deletions: 0,
    hunks: [
      {
        header: '@@ -0,0 +1,14 @@',
        lines: [
          'from kit.readers import vtex',
          '',
          `NAME = "${source}"`,
          `HOSTS = ["${run.domain}"]`,
          'PACING_S = 2.0',
          '',
          '',
          'def search(ean):',
          '    url = vtex.search_url(HOSTS[0], ean=ean)',
          '    for item in vtex.products(url):',
          '        offer = item["items"][0]["sellers"][0]["commertialOffer"]',
          `        price = ${priceField.startsWith('commertialOffer.') ? `offer["${priceField.split('.')[1]}"]` : `item["${priceField}"]`}`,
          '        yield vtex.row(item, price=price, available=offer["AvailableQuantity"] > 0)',
          '',
        ].map((text, i) => ({ kind: 'add' as const, new: i + 1, text })),
      },
    ],
  };
  const expected: ChangedFile = {
    path: `fixtures/${source}/expected.json`,
    status: run.attempts.length ? 'modified' : 'added',
    additions: 2,
    deletions: 2,
    hunks: [
      {
        header: '@@ -3,6 +3,6 @@',
        lines: [
          { kind: 'ctx', old: 3, new: 3, text: '    "gtin": "7501011115613",' },
          { kind: 'ctx', old: 4, new: 4, text: '    "title": "Doritos Incógnita 58 g",' },
          { kind: 'del', old: 5, text: '    "price": 19.0,' },
          { kind: 'del', old: 6, text: '    "available": null,' },
          { kind: 'add', new: 5, text: '    "price": 18.5,' },
          { kind: 'add', new: 6, text: '    "available": true,' },
          { kind: 'ctx', old: 7, new: 7, text: '    "currency": "MXN"' },
        ],
      },
    ],
  };
  const capture: ChangedFile = { path: `fixtures/${source}/page.html`, status: 'added', additions: 4180, deletions: 0, truncated: true, hunks: [] };
  return { source, head: run.branch ?? `source/${source}`, base: 'main', files: [sourceFile, expected, capture] };
}

// ---- The story ----

const PERFORMANCE: ReaderPerformance[] = [
  {
    reader: 'vtex',
    fresh: { builds: 5, passed: 3, firstTry: 1, avgAttempts: 2.4, avgAcus: 3.6, avgMinutes: 21 },
    reused: { builds: 3, passed: 3, firstTry: 3, avgAttempts: 1, avgAcus: 1.4, avgMinutes: 8 },
  },
  {
    reader: 'jsonld',
    fresh: { builds: 2, passed: 1, firstTry: 0, avgAttempts: 2.5, avgAcus: 2.9, avgMinutes: 17 },
    reused: { builds: 1, passed: 1, firstTry: 1, avgAttempts: 1, avgAcus: 1.2, avgMinutes: 7 },
  },
  {
    reader: 'nextjs',
    fresh: { builds: 1, passed: 0, firstTry: 0, avgAttempts: null, avgAcus: 1.2, avgMinutes: null },
    reused: { builds: 0, passed: 0, firstTry: 0, avgAttempts: null, avgAcus: null, avgMinutes: null },
  },
];

/** GET /decisions?reader=: per reader and topic, the choice a next build would get (a passed build's first), and how many builds made it. */
export function decisionLibrary(records: { rec: ConsoleRecord; run: AgentRun }[], now: number, reader?: string): DecisionLibrary {
  const all = records.flatMap(({ rec, run }) => decisionsAt(rec, now).map((d) => ({ ...d, outcome: run.state, reader: d.reader ?? rec.reader ?? null })));
  const byKey = new Map<string, (Decision & { uses: number })>();
  for (const d of all) {
    if (!d.reader || (reader && d.reader !== reader)) continue;
    const key = `${d.reader}|${d.topic}`;
    const uses = all.filter((o) => o.reader === d.reader && o.topic === d.topic && o.choice === d.choice).length;
    const prev = byKey.get(key);
    const better = !prev || (d.outcome === 'passed' && prev.outcome !== 'passed') || (d.outcome === prev.outcome && d.at > prev.at);
    if (better) byKey.set(key, { ...d, uses });
  }
  return { decisions: [...byKey.values()], performance: PERFORMANCE.filter((p) => !reader || p.reader === reader) };
}

interface StoryBuild {
  id: string;
  rec: ConsoleRecord;
}

/** The seeded builds, relative to `now`: asking, building, needs a person, passed, refused, cut off by a restart. */
export function consoleStory(now: number, refused: PageAccess): StoryBuild[] {
  const ago = (min: number) => iso(now - min * 60_000);
  const provider: AgentProvider = 'devin';
  const ev = (min: number, kind: AgentEvent['kind'], stage: string, message: string, attempt: number, extra: Partial<AgentEvent> = {}): AgentEvent => ({
    at: ago(min),
    kind,
    stage,
    message,
    attempt,
    ...extra,
  });
  const gated = (n: number, start: number, end: number, verdict: 'pass' | 'fail', failed: GateAttempt['failed'], sentBack = false): GateAttempt => ({
    n,
    startedAt: ago(start),
    endedAt: ago(end),
    outcome: 'pr_opened',
    verdict,
    passed: 14 - failed.length,
    total: 14,
    failed,
    sentBack,
  });
  const gateEvent = (min: number, n: number, source: string, failed: GateAttempt['failed']) =>
    ev(min, 'gate', 'gate', failed.length ? `Gate fail: ${14 - failed.length}/14 checks; failed ${failed.map((f) => f.name).join(', ')}` : 'Gate pass: 14/14 checks', n, {
      gate: { source, verdict: failed.length ? 'fail' : 'pass', passed: 14 - failed.length, total: 14 },
    });
  const allowed: PageAccess = { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' };
  const base = (id: string, domain: string, source: string | null, over: Partial<AgentRun>): AgentRun => ({
    buildId: id,
    provider,
    url: `https://www.${domain}/p/7501011115613`,
    domain,
    kind: 'third_party',
    state: 'building',
    stage: 'writing',
    note: '',
    source,
    sessionUrl: source ? `https://app.devin.ai/sessions/mock-${id}` : null,
    prUrl: null,
    branch: source ? `source/${source}` : null,
    access: allowed,
    attempt: 1,
    maxAttempts: 3,
    attempts: [],
    events: [],
    cost: {},
    startedAt: ago(10),
    endedAt: null,
    question: null,
    continues: null,
    live: true,
    ...over,
  });
  const decision = (id: string, domain: string, source: string, reader: string, min: number, card: DecisionCard): Decision => ({ ...card, at: ago(min), buildId: id, domain, source, reader });
  const decisionEvent = (d: Decision, attempt: number, min: number) =>
    ev(min, 'decision', 'writing', `${d.status === 'proposed' ? 'Picked' : d.status === 'confirmed' ? `Confirmed by ${d.by}:` : `Changed by ${d.by}:`} ${d.choice}`, attempt, {
      decision: { topic: d.topic, choice: d.choice, why: d.why, alternatives: d.alternatives, status: d.status, by: d.by },
    });
  const probe = (min: number, domain: string, reader: string) => [
    ev(min, 'system', 'probing', `Checking robots.txt on ${domain}`, 0),
    ev(min - 0.5, 'system', 'probing', `Probe: reader ${reader}`, 0),
  ];

  // La Comer: passed on attempt 2 two hours ago; its decisions are the ones the next VTEX build starts from.
  const lacomerId = 'demo-lacomer';
  const lcSrc = 'lacomer_mx';
  const lcDecisions: Decision[] = [
    decision(lacomerId, 'lacomer.com.mx', lcSrc, 'vtex', 128, { topic: 'reader', choice: 'vtex', why: 'The page calls /api/catalog_system/pub/products/search; the kit reads VTEX catalogs.', alternatives: ['jsonld', 'html'], status: 'confirmed', by: 'Harry' }),
    decision(lacomerId, 'lacomer.com.mx', lcSrc, 'vtex', 127, { topic: 'endpoint', choice: 'products/search?fq=alternateIds_Ean:{ean}', why: 'Finds the product by EAN in one request; the search page needs JavaScript.', alternatives: ['product page HTML', 'search page'], status: 'proposed', by: 'Devin' }),
    decision(lacomerId, 'lacomer.com.mx', lcSrc, 'vtex', 112, { topic: 'price', choice: 'commertialOffer.Price', why: 'The price the page shows. ListPrice is the struck-out one; attempt 1 read it and failed expected_values.', alternatives: ['commertialOffer.ListPrice', 'PriceWithoutDiscount'], status: 'changed', by: 'Harry' }),
    decision(lacomerId, 'lacomer.com.mx', lcSrc, 'vtex', 126, { topic: 'availability', choice: 'AvailableQuantity > 0', why: 'IsAvailable stays true for products out of stock in this store.', alternatives: ['IsAvailable'], status: 'proposed', by: 'Devin' }),
    decision(lacomerId, 'lacomer.com.mx', lcSrc, 'vtex', 126, { topic: 'pacing', choice: '1 request / 2 s', why: 'robots.txt asks for Crawl-delay: 2.', alternatives: ['1 request / s', '1 request / 5 s'], status: 'proposed', by: 'Devin' }),
  ];
  const lacomer = base(lacomerId, 'lacomer.com.mx', lcSrc, {
    state: 'passed',
    stage: 'done',
    note: `${lcSrc} passed the gate on attempt 2 and is live; its PR merges when CI passes`,
    attempt: 2,
    attempts: [gated(1, 129, 118, 'fail', [{ name: 'expected_values', detail: '3090610.price: 19.0 != 18.5 (read ListPrice, the page shows Price)' }], true), gated(2, 118, 106, 'pass', [])],
    events: [
      ...probe(130, 'lacomer.com.mx', 'vtex'),
      ev(129, 'system', 'writing', 'Attempt 1: Devin is building the scraper', 1),
      ...lcDecisions.filter((d) => d.status !== 'changed').map((d) => decisionEvent(d, 1, (now - Date.parse(d.at)) / 60_000)),
      ev(122, 'agent', 'capturing', 'Capturing one real product page as the fixture', 1),
      gateEvent(118, 1, lcSrc, [{ name: 'expected_values', detail: '3090610.price: 19.0 != 18.5' }]),
      ev(117.5, 'system', 'fixing', "Attempt 2: the gate's report went back to the same session", 2),
      decisionEvent(lcDecisions[2], 2, 112),
      ev(110, 'agent', 'fixing', 'Price now from commertialOffer.Price; matching by EAN', 2),
      gateEvent(106, 2, lcSrc, []),
      ev(105, 'system', 'merging', `Merging ${lcSrc} into the kit`, 2),
      ev(104, 'system', 'done', `${lcSrc} passed the gate on attempt 2 and is live; its PR merges when CI passes`, 2),
    ],
    prUrl: `https://github.com/HarryGomar/hackathon-devin-shelvin/pull/mock-${lcSrc}`,
    cost: { acus: 3.2 },
    startedAt: ago(130),
    endedAt: ago(104),
  });

  // Soriana: building normally, started from La Comer's decisions.
  const sorianaId = 'demo-soriana';
  const soSrc = 'soriana_mx';
  const reused = lcDecisions.map((d) => ({ ...d, outcome: 'passed' as BuildState }));
  const soDecisions = lcDecisions.map((d) => decision(sorianaId, 'soriana.com', soSrc, 'vtex', 7, { ...d, status: 'proposed', by: 'Devin', why: `${d.why} (from ${lcSrc})` }));
  const soriana = base(sorianaId, 'soriana.com', soSrc, {
    stage: 'capturing',
    note: 'Capturing one real product page as the fixture',
    events: [
      ...probe(9, 'soriana.com', 'vtex'),
      ev(8, 'system', 'writing', `Attempt 1: Devin is building the scraper, starting from ${lcSrc}'s ${lcDecisions.length} decisions`, 1),
      ...soDecisions.map((d) => decisionEvent(d, 1, 7)),
      ev(5, 'agent', 'writing', `Wrote sources/${soSrc}.py from the VTEX reader with the saved price and pacing`, 1),
      ev(2, 'agent', 'capturing', 'Capturing one real product page as the fixture', 1),
    ],
    cost: { acus: 0.9 },
    startedAt: ago(9),
  });

  // Walmart: Devin asked a question and waits for a person.
  const walmartId = 'demo-walmart';
  const wmSrc = 'walmart_mx';
  const question = 'Prices load after the page from /api/catalog on the same host (robots.txt allows it). Should I read that API, or keep to the HTML and its __NEXT_DATA__?';
  const wmDecisions = [
    decision(walmartId, 'walmart.com.mx', wmSrc, 'nextjs', 5, { topic: 'reader', choice: 'nextjs', why: 'The product data is in __NEXT_DATA__ on the page.', alternatives: ['jsonld', 'html'], status: 'proposed', by: 'Devin' }),
    decision(walmartId, 'walmart.com.mx', wmSrc, 'nextjs', 4, { topic: 'product_id', choice: 'EAN from the URL', why: 'The URL ends in the EAN, so no search request is needed.', alternatives: ['search by name', 'sku'], status: 'proposed', by: 'Devin' }),
  ];
  const walmart = base(walmartId, 'walmart.com.mx', wmSrc, {
    stage: 'writing',
    note: 'Waiting for an answer: where to read prices',
    question,
    events: [
      ...probe(6.5, 'walmart.com.mx', 'nextjs'),
      ev(6, 'system', 'writing', 'Attempt 1: Devin is building the scraper', 1),
      ...wmDecisions.map((d) => decisionEvent(d, 1, (now - Date.parse(d.at)) / 60_000)),
      ev(3, 'agent', 'writing', 'The saved page has no prices: they load after the page', 1),
      ev(1, 'agent', 'writing', `Asking: ${question}`, 1),
    ],
    cost: { acus: 1.2 },
    startedAt: ago(6.5),
  });

  // Chedraui: three failed gates (one touched a file outside its two paths), needs a person.
  const chedrauiId = 'demo-chedraui';
  const chSrc = 'chedraui_mx';
  const price = [{ name: 'expected_values', detail: '3090610.price: 21.0 != 19.5 (read ListPrice, the page shows Price)' }];
  const paths = [{ name: 'allowed_paths', detail: 'changed kit/readers/vtex.py, outside sources/ and fixtures/' }];
  const rows = [
    { name: 'fixture_rows', detail: 'the saved page has 0 product rows (prices load after the page)' },
    { name: 'live_product_found', detail: 'the scanned product is not among the rows' },
  ];
  const chDecisions = [
    decision(chedrauiId, 'chedraui.com.mx', chSrc, 'vtex', 52, { topic: 'reader', choice: 'vtex', why: 'The probe found a VTEX store.', alternatives: ['jsonld', 'html'], status: 'proposed', by: 'Devin' }),
    decision(chedrauiId, 'chedraui.com.mx', chSrc, 'vtex', 51, { topic: 'price', choice: 'commertialOffer.ListPrice', why: 'ListPrice is filled for every product in the search answer.', alternatives: ['commertialOffer.Price', 'PriceWithoutDiscount'], status: 'proposed', by: 'Devin' }),
    decision(chedrauiId, 'chedraui.com.mx', chSrc, 'vtex', 51, { topic: 'product_id', choice: 'productId', why: 'The search answer keys products by productId.', alternatives: ['EAN', 'sku'], status: 'proposed', by: 'Devin' }),
    decision(chedrauiId, 'chedraui.com.mx', chSrc, 'vtex', 50, { topic: 'pacing', choice: '1 request / s', why: 'No Crawl-delay in robots.txt.', alternatives: ['1 request / 2 s'], status: 'proposed', by: 'Devin' }),
  ];
  const chedraui = base(chedrauiId, 'chedraui.com.mx', chSrc, {
    state: 'needs_person',
    stage: 'done',
    note: 'The gate failed 3 attempts (expected_values, allowed_paths, fixture_rows); a person needs to look',
    attempt: 3,
    attempts: [gated(1, 52, 44, 'fail', price, true), gated(2, 44, 36, 'fail', [...price, ...paths], true), gated(3, 36, 28, 'fail', rows)],
    events: [
      ...probe(53, 'chedraui.com.mx', 'vtex'),
      ev(52, 'system', 'writing', 'Attempt 1: Devin is building the scraper', 1),
      ...chDecisions.map((d) => decisionEvent(d, 1, (now - Date.parse(d.at)) / 60_000)),
      ev(47, 'agent', 'capturing', 'Capturing one real product page as the fixture', 1),
      gateEvent(44, 1, chSrc, price),
      ev(43.5, 'system', 'fixing', "Attempt 2: the gate's report went back to the same session", 2),
      ev(40, 'agent', 'fixing', 'Patched the VTEX reader to read prices for this store', 2),
      gateEvent(36, 2, chSrc, [...price, ...paths]),
      ev(35.5, 'system', 'fixing', "Attempt 3: the gate's report went back to the same session", 3),
      ev(32, 'agent', 'fixing', 'Reverted the reader; saving a new fixture page', 3),
      gateEvent(28, 3, chSrc, rows),
      ev(27.5, 'system', 'done', 'The gate failed 3 attempts (expected_values, allowed_paths, fixture_rows); a person needs to look', 3),
    ],
    cost: { acus: 4.6 },
    startedAt: ago(53),
    endedAt: ago(27.5),
  });

  // Amazon: refused before any session.
  const amazonId = 'demo-amazon';
  const amazon = base(amazonId, 'amazon.com.mx', null, {
    state: 'refused',
    stage: 'probing',
    note: refused.reason,
    access: refused,
    attempt: 0,
    maxAttempts: 0,
    events: [ev(70, 'system', 'probing', `Refused: ${refused.reason}`, 0)],
    startedAt: ago(70),
    endedAt: ago(70),
    live: false,
  });

  // H-E-B: left 'building' when the backend restarted; nothing runs it now.
  const hebId = 'demo-heb';
  const hebSrc = 'heb_mx';
  const hebDecisions = [
    decision(hebId, 'heb.com.mx', hebSrc, 'jsonld', 46, { topic: 'reader', choice: 'jsonld', why: 'Each product page carries a schema.org Product block.', alternatives: ['html'], status: 'proposed', by: 'Devin' }),
    decision(hebId, 'heb.com.mx', hebSrc, 'jsonld', 45, { topic: 'price', choice: 'offers.price', why: 'The schema.org offer is the price the page shows.', alternatives: ['meta[itemprop=price]'], status: 'proposed', by: 'Devin' }),
  ];
  const heb = base(hebId, 'heb.com.mx', hebSrc, {
    stage: 'testing',
    note: 'Fixture written; running the tests',
    events: [
      ...probe(48, 'heb.com.mx', 'jsonld'),
      ev(47, 'system', 'writing', 'Attempt 1: Devin is building the scraper', 1),
      ...hebDecisions.map((d) => decisionEvent(d, 1, (now - Date.parse(d.at)) / 60_000)),
      ev(42, 'agent', 'testing', 'Fixture written; running the tests', 1),
      ev(41, 'system', 'testing', 'The backend restarted; this build is no longer running', 1),
    ],
    cost: { acus: 1.8 },
    startedAt: ago(48),
    live: false,
  });

  const fixed = (run: AgentRun) => () => run;
  return [
    { id: walmartId, rec: record(fixed(walmart), { decisions: wmDecisions, reader: 'nextjs' }) },
    { id: sorianaId, rec: record(fixed(soriana), { decisions: soDecisions, reused, reader: 'vtex' }) },
    { id: chedrauiId, rec: record(fixed(chedraui), { decisions: chDecisions, reader: 'vtex' }) },
    { id: hebId, rec: record(fixed(heb), { decisions: hebDecisions, reader: 'jsonld' }) },
    { id: amazonId, rec: record(fixed(amazon), { reader: null }) },
    { id: lacomerId, rec: record(fixed(lacomer), { decisions: lcDecisions, reader: 'vtex', insightsReady: true }) },
  ];
}

/** The price field the record's current decisions say, for its diff. */
export function priceFieldOf(decisions: Decision[]) {
  return decisions.find((d) => d.topic === 'price')?.choice;
}
