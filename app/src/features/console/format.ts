import type { AgentEvent, AgentRun, BuildControl, BuildDetail, BuildHistory, BuildState, DecisionCard, DiffLine, GateCheck, NoteContext, SessionInsights } from '@/api/types';
import { clockTime, costText, isActive, lastGated, stateWord } from '@/features/builds/format';
import type { Tone } from '@/theme';

import { strings } from './strings';

export type GroupKey = 'needs' | 'building' | 'queued' | 'passed' | 'failed';

const GROUP_STATES: Record<Exclude<GroupKey, 'needs'>, BuildState[]> = {
  building: ['running', 'building', 'fixing'],
  queued: ['queued'],
  passed: ['passed', 'exists'],
  failed: ['failed', 'blocked', 'unreachable', 'refused', 'stopped', 'needs_person'],
};
const GROUP_ORDER: GroupKey[] = ['needs', 'building', 'queued', 'passed', 'failed'];

/** A build needs you when Devin asked a question, it needs a person or is blocked, or it was cut off by a restart. */
export function needsYou(run: Pick<AgentRun, 'question' | 'state' | 'live'>) {
  return !!run.question || run.state === 'needs_person' || run.state === 'blocked' || (isActive(run.state) && run.live === false);
}

/** The board's status word: ASKING for a question, CUT OFF for a build nothing runs, else the state. */
export function boardWord(run: AgentRun): { label: string; tone: Tone } {
  if (run.question) return { label: strings.asking, tone: 'warning' };
  if (isActive(run.state) && run.live === false) return { label: strings.cutOff, tone: 'warning' };
  return stateWord(run.state);
}

/** The board: NEEDS YOU, BUILDING, QUEUED, PASSED, FAILED, each in the history's order (newest first). */
export function boardGroups(builds: AgentRun[]): { key: GroupKey; label: string; builds: AgentRun[] }[] {
  return GROUP_ORDER.map((key) => ({
    key,
    label: strings.groups[key],
    builds: builds.filter((r) => (key === 'needs' ? needsYou(r) : !needsYou(r) && GROUP_STATES[key].includes(r.state))),
  }));
}

export function firstNeedingYou(builds: AgentRun[]) {
  return builds.find(needsYou);
}

const sameDay = (iso: string, now: number) => {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

/** The strip: builders working, today's cost, how many need you, failed gates, allowed_paths failures, refusals. */
export function stripTotals(history: BuildHistory, now = Date.now()) {
  const today = history.builds.filter((r) => sameDay(r.startedAt, now));
  const acus = today.reduce((sum, r) => sum + (r.cost?.acus ?? 0), 0);
  const usd = today.reduce((sum, r) => sum + (r.cost?.usd ?? 0), 0);
  const attempts = history.builds.flatMap((r) => r.attempts);
  return {
    running: history.running,
    parallel: history.parallel,
    todayCost: costText({ ...(acus ? { acus } : {}), ...(usd ? { usd } : {}) }),
    needsYou: history.builds.filter(needsYou).length,
    firstNeedingYou: firstNeedingYou(history.builds),
    failedGates: attempts.filter((a) => a.verdict === 'fail').length,
    allowedPaths: attempts.filter((a) => a.failed.some((f) => f.name === 'allowed_paths')).length,
    refused: history.builds.filter((r) => r.state === 'refused').length,
  };
}

/** A card's middle line: "capturing · Capturing one real product page". */
export function cardNote(run: AgentRun) {
  return [run.stage, run.question ?? run.note].filter(Boolean).join(' · ');
}

/** A card's last line: "attempt 2/3 · gate 12/14 · 2.8 ACU". */
export function cardMeta(run: AgentRun) {
  const gated = lastGated(run);
  return [run.maxAttempts > 0 ? `attempt ${run.attempt}/${run.maxAttempts}` : undefined, gated ? `gate ${gated.passed}/${gated.total}` : undefined, costText(run.cost)]
    .filter(Boolean)
    .join(' · ');
}

export function eventContext(event: AgentEvent): NoteContext {
  return { kind: 'event', at: event.at, message: event.message };
}

export function checkContext(check: GateCheck): NoteContext {
  return { kind: 'check', name: check.name, detail: check.detail };
}

/** A diff line as what a message is about: the new line number, or the old one for a removed line. */
export function lineContext(path: string, line: DiffLine): NoteContext {
  return { kind: 'line', path, line: line.new ?? line.old ?? 0, text: line.text };
}

/** The context chip: "TRACE 14:05:09", "CHECK expected_values", "sources/walmart_mx.py:42". */
export function contextLabel(context: NoteContext) {
  switch (context.kind) {
    case 'event':
      return `trace ${clockTime(context.at)}`;
    case 'check':
      return `check ${context.name}`;
    default:
      return `${context.path}:${context.line}`;
  }
}

const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The quote above a message: "> 14:05:09 Gate fail…", "> expected_values: …", "> sources/x.py:42  price = …". */
export function quoteText(context: NoteContext) {
  const body =
    context.kind === 'event'
      ? `${clockTime(context.at)} ${context.message}`
      : context.kind === 'check'
        ? `${context.name}: ${context.detail}`
        : `${context.path}:${context.line}  ${context.text.trim()}`;
  return clip(body)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Another attempt's note: the quote first, when the message was about something. */
export function retryNote(message: string, context?: NoteContext) {
  return context ? `${quoteText(context)}\n\n${message}` : message;
}

export function sameContext(a: NoteContext | undefined, b: NoteContext) {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** A gate run someone asked for (person event, stage gate) with no manual gate result after it yet. */
export function gatePending(events: AgentEvent[]) {
  let asked = -1;
  events.forEach((e, i) => {
    if (e.kind === 'person' && e.stage === 'gate') asked = i;
  });
  return asked >= 0 && !events.slice(asked + 1).some((e) => e.kind === 'gate' && e.gate?.manual);
}

export function latestManualGate(events: AgentEvent[]) {
  return [...events].reverse().find((e) => e.kind === 'gate' && e.gate?.manual);
}

/** The selected build polls while it runs, a gate run is pending, or Devin is analysing it. */
export function buildPolls(build: BuildDetail, insightsStarted: boolean) {
  return (isActive(build.state) && build.live !== false) || gatePending(build.events) || insightsStarted;
}

/** A control as the backend decided it; a backend that sends no controls doesn't run the console yet. */
export function controlOf(build: Pick<BuildDetail, 'controls'>, key: BuildControl): { ok: boolean; why?: string } {
  const c = build.controls?.[key];
  if (!c) return { ok: false, why: strings.noControls };
  return c.ok ? c : { ok: false, why: c.why ?? strings.noControls };
}

/** "Acting as": a saved name, trimmed; empty or missing gives Harry. */
export function parseActingAs(value: unknown) {
  const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  return name || strings.defaultActor;
}

/** "proposed", "confirmed by Harry", "changed by Harry". */
export function decisionStatus(card: DecisionCard) {
  return card.status === 'proposed' ? strings.statuses.proposed : strings.statuses[card.status](card.by);
}

export function decisionTone(card: DecisionCard): Tone {
  return card.status === 'proposed' ? 'neutral' : card.status === 'confirmed' ? 'success' : 'warning';
}

/** "size M · 3.1 ACU · 4 you · 22 Devin". */
export function insightsLine(insights: SessionInsights) {
  return [
    insights.size ? strings.size(insights.size) : undefined,
    typeof insights.acus === 'number' ? `${insights.acus} ACU` : undefined,
    insights.messages ? strings.messages(insights.messages.user, insights.messages.devin) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function diffSign(kind: DiffLine['kind']) {
  return kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
}

/** A message from an error, short. */
export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
