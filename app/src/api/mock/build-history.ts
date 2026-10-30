// The mock's GET /builds and GET /builds/:buildId, from the AgentRuns it recorded: the per-site tally, the totals,
// and a gate report per attempt (the timeline keeps only the failed checks, so the passing ones are filled in).

import type { AgentRun, BuildDetail, BuildHistory, BuildQuery, BuildSite, BuildState, GateAttempt, GateReport } from '../types';

/** The kit gate's offline checks, in its order (scraper-kit/kit/gate.py). */
export const GATE_CHECKS = [
  'source_declares',
  'source_loads',
  'one_source_per_host',
  'files_unchanged',
  'fixture_exists',
  'fixture_size',
  'fixture_robots',
  'fixture_reads',
  'fixture_grounded',
  'expected_written',
  'expected_rows',
  'expected_values',
  'live_reachable',
  'live_product_found',
];

const FAILED: BuildState[] = ['failed', 'needs_person', 'blocked', 'unreachable'];
/** A builder session is working on it. */
const WORKING: BuildState[] = ['running', 'building', 'fixing'];
const ACTIVE: BuildState[] = ['queued', ...WORKING];

const lastActivity = (run: AgentRun) => run.endedAt ?? run.events[run.events.length - 1]?.at ?? run.startedAt;

/** The history for `runs` (any order): `builds` filtered by `query`, newest first; `sites` and `totals` over every run. */
export function buildHistory(runs: AgentRun[], query: BuildQuery = {}, parallel = 4): BuildHistory {
  const newest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const builds = newest
    .filter((r) => (!query.domain || r.domain === query.domain) && (!query.state || r.state === query.state))
    .slice(0, query.limit ?? 50)
    .map((r) => ({ ...r, events: r.events.slice(-5) }));
  const count = (list: AgentRun[], states: BuildState[]) => list.filter((r) => states.includes(r.state)).length;

  const byDomain = new Map<string, AgentRun[]>();
  for (const r of newest) byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
  const sites: BuildSite[] = [...byDomain.entries()].map(([domain, list]) => {
    const last = list[0];
    return {
      domain,
      builds: list.length,
      passed: count(list, ['passed']),
      failed: count(list, FAILED),
      refused: count(list, ['refused']),
      lastState: last.state,
      lastBuildId: last.buildId,
      lastAt: lastActivity(last),
      source: list.find((r) => r.source)?.source ?? null,
    };
  });
  sites.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  return {
    builds,
    sites,
    totals: { builds: runs.length, passed: count(runs, ['passed']), failed: count(runs, FAILED), refused: count(runs, ['refused']), running: count(runs, ACTIVE) },
    // A build cut off by a restart (live false) has no session working on it.
    running: runs.filter((r) => WORKING.includes(r.state) && r.live !== false).length,
    parallel,
  };
}

/** The gate's report on one attempt: its failed checks as recorded, the rest passing. Null before the gate ran. */
export function gateReportFor(attempt: GateAttempt, source: string | null): GateReport | null {
  if (!attempt.verdict) return null;
  const failed = new Map(attempt.failed.map((f) => [f.name, f.detail]));
  const passing = GATE_CHECKS.filter((name) => !failed.has(name)).slice(0, Math.max(0, attempt.total - failed.size));
  // The kit's order; a failed check the list doesn't know goes last.
  const names = [...GATE_CHECKS.filter((name) => failed.has(name) || passing.includes(name)), ...[...failed.keys()].filter((name) => !GATE_CHECKS.includes(name))];
  const checks = names.map((name) => ({ name, passed: !failed.has(name), detail: failed.get(name) ?? 'ok' }));
  return { source, verdict: attempt.verdict, rows: attempt.verdict === 'pass' ? 12 : undefined, checks };
}

/** GET /builds/:buildId for a recorded run: every event and a gate report per attempt. */
export function buildDetail(run: AgentRun): BuildDetail {
  return { ...run, events: [...run.events], gates: run.attempts.map((a) => gateReportFor(a, run.source ?? null)) };
}
