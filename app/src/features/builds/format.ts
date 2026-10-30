import type { AgentEvent, AgentRun, BuildState, GateAttempt, GateReport } from '@/api/types';
import { formatDateTime } from '@/features/results/format';
import type { Tone } from '@/theme';

import { strings } from './strings';

const ACTIVE: BuildState[] = ['queued', 'running', 'building', 'fixing'];

const STATE_TONES: Record<BuildState, Tone> = {
  queued: 'neutral',
  running: 'accent',
  building: 'accent',
  fixing: 'warning',
  passed: 'success',
  exists: 'success',
  failed: 'danger',
  refused: 'danger',
  blocked: 'danger',
  unreachable: 'warning',
  needs_person: 'warning',
  stopped: 'neutral',
};

/** Still going: queued, or a builder session on it. The screens poll while one is. */
export function isActive(state: BuildState) {
  return ACTIVE.includes(state);
}

export function anyActive(runs: Pick<AgentRun, 'state'>[]) {
  return runs.some((r) => isActive(r.state));
}

/** PASSED in green, FIXING in amber: the status word for a build state. A state the app doesn't know shows as is. */
export function stateWord(state: BuildState): { label: string; tone: Tone } {
  return { label: strings.states[state] ?? state, tone: STATE_TONES[state] ?? 'neutral' };
}

/** "42s", "3m 05s", "1h 02m": start to end, or to `now` while it runs. Undefined for a missing or bad date. */
export function durationText(startedAt: string | undefined, endedAt?: string | null, now = Date.now()): string | undefined {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = endedAt ? Date.parse(endedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "14:05:09" in the device's time zone: the trace's time column. */
export function clockTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "Oct 29, 14:05 · 1m 12s": when the build started and how long it ran (so far, while it runs). */
export function whenLine(run: Pick<AgentRun, 'startedAt' | 'endedAt'>, now = Date.now()) {
  return [formatDateTime(run.startedAt), durationText(run.startedAt, run.endedAt, now)].filter(Boolean).join(' · ');
}

/** Who wrote a trace line: backend, builder, builder gate (the builder ran the gate itself) or gate (the backend's). */
export function kindTag(kind: AgentEvent['kind']) {
  return strings.kindTags[kind] ?? kind;
}

/** A trace line's tag color: the gate's verdict when the line carries one, else backend grey and builder aqua. */
export function eventTone(event: AgentEvent): Tone {
  if (event.kind === 'person' || event.kind === 'decision') return 'info';
  if (event.gate) return event.gate.verdict === 'pass' ? 'success' : event.gate.verdict === 'fail' ? 'danger' : 'warning';
  return event.kind === 'system' ? 'neutral' : 'accent';
}

/** "BUILDER · WRITING": the tag line above a trace message. */
export function eventTag(event: AgentEvent) {
  if (event.kind === 'person') return [kindTag(event.kind), event.by].filter(Boolean).join(' · ').toUpperCase();
  if (event.kind === 'decision') return [kindTag(event.kind), event.decision?.topic].filter(Boolean).join(' · ').toUpperCase();
  return [kindTag(event.kind), event.stage].filter(Boolean).join(' · ').toUpperCase();
}

/** The latest attempt the gate judged. */
export function lastGated(run: Pick<AgentRun, 'attempts'>): GateAttempt | undefined {
  return [...run.attempts].reverse().find((a) => a.verdict);
}

/** "2.8 ACU · $1.20", or undefined when the backend reported no cost. */
export function costText(cost: AgentRun['cost']): string | undefined {
  const parts = [
    typeof cost?.acus === 'number' ? strings.acus(Math.round(cost.acus * 100) / 100) : undefined,
    typeof cost?.usd === 'number' ? strings.usd(cost.usd) : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** A build row's meta line: "Devin · attempt 2/3 · gate 14/14 · 2.8 ACU". Refused builds (no attempts) show only the builder. */
export function buildMeta(run: AgentRun) {
  const gated = lastGated(run);
  return [
    strings.providers[run.provider] ?? run.provider,
    run.maxAttempts > 0 ? strings.attempt(run.attempt, run.maxAttempts) : undefined,
    gated ? strings.gate(gated.passed, gated.total) : undefined,
    costText(run.cost),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** PASS / FAIL / UNREACHABLE once gated; WORKING while the attempt runs; NO GATE when it ended without one. */
export function verdictWord(attempt: GateAttempt, buildActive: boolean): { label: string; tone: Tone } {
  switch (attempt.verdict) {
    case 'pass':
      return { label: strings.verdicts.pass, tone: 'success' };
    case 'fail':
      return { label: strings.verdicts.fail, tone: 'danger' };
    case 'unreachable':
      return { label: strings.verdicts.unreachable, tone: 'warning' };
    default:
      return buildActive && !attempt.endedAt ? { label: strings.verdicts.working, tone: 'accent' } : { label: strings.verdicts.none, tone: 'neutral' };
  }
}

/** "PR opened" for the builder's outcome code; a code the app doesn't know reads with spaces ("tests_failed" → "tests failed"). */
export function outcomeText(outcome?: string | null) {
  if (!outcome) return strings.noOutcome;
  return strings.outcomes[outcome] ?? outcome.replace(/_/g, ' ');
}

/** "fail · 12/14 · walmart_mx · 32 rows": one gate run, for its collapsible header. */
export function gateSummary(report: GateReport) {
  const passed = report.checks.filter((c) => c.passed).length;
  return [
    (strings.verdicts[report.verdict] ?? report.verdict).toLowerCase(),
    `${passed}/${report.checks.length}`,
    report.source,
    // The backend writes `rows: null` when the gate counted none.
    typeof report.rows === 'number' ? strings.rows(report.rows) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Index of the last attempt with a gate report: its checks start open. -1 when none has one. */
export function lastGateIndex(gates: (GateReport | null)[] | undefined) {
  if (!gates) return -1;
  for (let i = gates.length - 1; i >= 0; i -= 1) if (gates[i]) return i;
  return -1;
}
