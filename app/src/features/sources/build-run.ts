// Pure helpers for showing a scraper build (the backend's AgentRun): who builds it, its step, its attempts.

import type { AgentProvider, AgentRun, BuildBatchResult, BuildState, GateAttempt, JobStatus, PageAccess, ScrapeSite } from '@/api/types';
import { failureReasonLabel } from '@/features/results/failure-reason';
import type { Tone } from '@/theme';

/** The backend's build job steps, in order (backend/server/builds.py STEPS). */
export const BUILD_STEP_KEYS = ['probe', 'build', 'gate', 'merge'] as const;
export type BuildStepKey = (typeof BUILD_STEP_KEYS)[number];

/** The builder's stage → the job step it belongs to (builds.py STEP_OF_STAGE). */
const STEP_OF_STAGE: Record<string, BuildStepKey> = {
  queued: 'probe',
  probing: 'probe',
  writing: 'build',
  capturing: 'build',
  testing: 'build',
  fixing: 'build',
  reporting: 'build',
  gate: 'gate',
  merging: 'merge',
  done: 'merge',
};

const PROVIDERS: Record<AgentProvider, string> = { devin: 'Devin', claude_code: 'Claude Code', scripted: 'Scripted', mock: 'Demo' };

/** The site a build is for, as the backend keys it: the host, lower case, without "www." (kit domain_of). */
export function domainOfUrl(url: string): string {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return (match?.[1] ?? url.trim()).toLowerCase().replace(/^www\./, '');
}

/** "Devin", "Claude Code", "Scripted"; an unknown provider is shown as sent. */
export function providerLabel(provider: AgentProvider | string | undefined): string {
  if (!provider) return 'Agent';
  return PROVIDERS[provider as AgentProvider] ?? provider;
}

const STATES: Record<BuildState, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Building', tone: 'info' },
  building: { label: 'Building', tone: 'info' },
  fixing: { label: 'Fixing', tone: 'warning' },
  passed: { label: 'Live', tone: 'success' },
  exists: { label: 'Live', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  refused: { label: 'Refused', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' },
  unreachable: { label: 'Unreachable', tone: 'warning' },
  needs_person: { label: 'Needs a person', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

/** The status word for a build: its run's state, else the job's status. */
export function buildStateWord(state: BuildState | undefined, status?: JobStatus): { label: string; tone: Tone } {
  if (state && STATES[state]) return STATES[state];
  if (status === 'succeeded') return STATES.passed;
  if (status === 'failed') return STATES.failed;
  return status === 'queued' ? STATES.queued : STATES.running;
}

/** The step the build is on: the job's progress step when it is one of the four, else from the run's stage. */
export function currentBuildStep(progressStep: string | undefined, stage: string | undefined): BuildStepKey {
  if (progressStep && (BUILD_STEP_KEYS as readonly string[]).includes(progressStep)) return progressStep as BuildStepKey;
  return STEP_OF_STAGE[stage ?? ''] ?? 'probe';
}

/**
 * The step to show: like `currentBuildStep`, except that a build which ended failed after the gate failed its last
 * attempt shows the failure on GATE (the backend files the gate's own events under its build step).
 */
export function shownBuildStep(progressStep: string | undefined, run: Pick<AgentRun, 'stage' | 'attempts'> | undefined, ended: 'passed' | 'failed' | undefined): BuildStepKey {
  const last = run?.attempts[run.attempts.length - 1];
  if (ended === 'failed' && last?.verdict === 'fail') return 'gate';
  return currentBuildStep(progressStep, run?.stage);
}

export type StepState = 'done' | 'current' | 'todo' | 'failed';

/** Each of the four steps: done before the current one; the current one failed if the build ended without passing. */
export function buildStepStates(current: BuildStepKey, ended: 'passed' | 'failed' | undefined): { key: BuildStepKey; state: StepState }[] {
  const at = BUILD_STEP_KEYS.indexOf(current);
  return BUILD_STEP_KEYS.map((key, i) => {
    if (ended === 'passed') return { key, state: 'done' };
    if (i < at) return { key, state: 'done' };
    if (i === at) return { key, state: ended === 'failed' ? 'failed' : 'current' };
    return { key, state: 'todo' };
  });
}

/** Whether a build is over, and how: from the run's state, else the job's status. */
export function buildEnded(state: BuildState | undefined, status: JobStatus | undefined): 'passed' | 'failed' | undefined {
  if (state === 'passed' || state === 'exists') return 'passed';
  if (state && ['failed', 'refused', 'blocked', 'unreachable', 'needs_person'].includes(state)) return 'failed';
  if (status === 'succeeded') return 'passed';
  if (status === 'failed') return 'failed';
  return undefined;
}

/**
 * The site refused the builder: the run's own refusal (robots.txt, AI opt-out), or a build that ended `blocked` (the
 * site answered 401/403/429 or a bot challenge). The run's `access` is still robots.txt's "allowed" then, because a
 * 403 isn't in robots.txt, so it says refused here, like a scrape the site blocked (withScrapeBlock).
 */
export function buildRefusal(run: Pick<AgentRun, 'state' | 'note' | 'access'> | undefined): PageAccess | undefined {
  if (run?.access?.status === 'refused') return run.access;
  if (run?.state === 'blocked') return { status: 'refused', code: 'blocked', reason: run.note || 'The site refused our requests' };
  return undefined;
}

/** "GATE PASS 14/14", "GATE FAIL 12/14", "BUILDING" while the attempt has no verdict yet. */
export function attemptVerdict(a: GateAttempt): { label: string; tone: Tone } {
  if (a.verdict === 'pass') return { label: `Gate pass ${a.passed}/${a.total}`, tone: 'success' };
  if (a.verdict === 'fail') return { label: `Gate fail ${a.passed}/${a.total}`, tone: 'danger' };
  if (a.verdict === 'unreachable') return { label: 'Site unreachable', tone: 'warning' };
  if (!a.endedAt) return { label: 'Working', tone: 'info' };
  const refused = a.outcome === 'blocked' || a.outcome === 'refused';
  return { label: a.outcome ?? 'Ended', tone: refused ? 'danger' : 'neutral' };
}

/** "2.8 ACUs" (Devin) or "$0.42" (Claude Code); undefined when nothing was spent yet. */
export function costText(cost: AgentRun['cost']): string | undefined {
  if (cost?.acus !== undefined) return `${cost.acus} ACU${cost.acus === 1 ? '' : 's'}`;
  if (cost?.usd !== undefined) return `$${cost.usd.toFixed(2)}`;
  return undefined;
}

/** The one-line summary of a finished build: "built by Devin · attempt 2 of 3 · gate 14/14". */
export function builtSummary(run: AgentRun): string {
  const who = providerLabel(run.provider);
  if (run.state === 'exists') return `scraper already existed (${run.source ?? run.domain})`;
  const passed = [...run.attempts].reverse().find((a) => a.verdict === 'pass');
  const parts = [`built by ${who}`, `attempt ${run.attempt} of ${run.maxAttempts}`];
  if (passed) parts.push(`gate ${passed.passed}/${passed.total}`);
  return parts.join(' · ');
}

/** The one-line state of a running build: "Devin · attempt 2 of 3 · fixing". */
export function runningSummary(run: AgentRun | undefined, status: JobStatus): string {
  if (!run) return status === 'queued' ? 'queued' : 'building';
  const who = providerLabel(run.provider);
  const word = buildStateWord(run.state, status).label.toLowerCase();
  if (run.attempt === 0) return `${who} · ${word}`;
  return `${who} · attempt ${run.attempt} of ${run.maxAttempts} · ${word}`;
}

/** Why "Build all missing" skipped a page, in the app's words. */
export function skippedReason(skip: BuildBatchResult['skipped'][number]): string {
  if (skip.code === 'has_scraper' || skip.reason === 'already has a scraper') return 'already has a scraper';
  if (skip.code === 'unknown_page' || skip.reason === 'unknown page') return 'the backend doesn’t know this page; search again';
  return failureReasonLabel(skip.code, skip.reason);
}

/** Skipped pages, one entry per site and reason (several pages on one site are skipped for the same reason). */
export function skippedBySite(skipped: BuildBatchResult['skipped']): (BuildBatchResult['skipped'][number] & { pages: number })[] {
  const out = new Map<string, BuildBatchResult['skipped'][number] & { pages: number }>();
  for (const k of skipped) {
    const key = `${k.domain ?? k.pageId}\u0000${k.code ?? k.reason}`;
    const seen = out.get(key);
    if (seen) seen.pages += 1;
    else out.set(key, { ...k, pages: 1 });
  }
  return [...out.values()];
}

const SITE_STATES: Record<ScrapeSite['state'], { label: string; tone: Tone }> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  fetching: { label: 'Reading', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  refused: { label: 'Refused', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

/** The status word for one site during a scrape. */
export function siteStateWord(state: ScrapeSite['state']): { label: string; tone: Tone } {
  return SITE_STATES[state] ?? { label: state, tone: 'neutral' };
}
