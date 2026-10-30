import { useCallback, useState } from 'react';

import { getApi } from '@/api/client';
import { ApiError } from '@/api/http';
import type { BuildDetail, SessionInsights } from '@/api/types';
import { usePolled } from '@/features/builds/use-builds';

import { buildPolls, errorText } from './format';
import { strings } from './strings';

const HISTORY_MS = 3000;
const BUILD_MS = 2000;
const OFF = 'off:';

const always = () => true;
const once = () => false;
const loadHistory = () => getApi().listBuilds();

/** GET /builds every 3 s while the console is focused. */
export function useConsoleHistory() {
  return usePolled('console-builds', loadHistory, always, HISTORY_MS);
}

const loadBuild = (id: string) => getApi().getBuild(id);

/** GET /builds/:id every 2 s while it runs, a gate run is pending, or Devin is analysing it. */
export function useConsoleBuild(id: string, insightsStarted: boolean) {
  const keep = useCallback((b: BuildDetail) => buildPolls(b, insightsStarted), [insightsStarted]);
  return usePolled(id, loadBuild, keep, BUILD_MS);
}

const loadChanges = (id: string) => getApi().getBuildChanges(id);

/** GET /builds/:id/changes, again every 3 s while the build runs. */
export function useChanges(id: string, active: boolean) {
  const keep = useCallback(() => active, [active]);
  return usePolled(id, loadChanges, keep, HISTORY_MS);
}

const loadInsights = (key: string): Promise<SessionInsights | null> => (key.startsWith(OFF) ? Promise.resolve(null) : getApi().getBuildInsights(key));
const insightsRunning = (i: SessionInsights | null) => i?.status === 'started';

/** GET /builds/:id/insights once `enabled` (the tab was opened), every 2 s while Devin is analysing. */
export function useInsights(id: string, enabled: boolean) {
  return usePolled(enabled ? id : `${OFF}${id}`, loadInsights, insightsRunning, BUILD_MS);
}

// A backend without the console answers 404: say so instead of the raw error.
const loadLibrary = () =>
  getApi()
    .listDecisions()
    .catch((e: unknown) => {
      throw e instanceof ApiError && e.status === 404 ? new Error(strings.noControls) : e;
    });

/** GET /decisions, on focus and on refresh. */
export function useDecisionLibrary() {
  return usePolled('decisions', loadLibrary, once);
}

/** Runs one console action at a time: which one is busy, and its error until the next action. */
export function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useCallback(async <T,>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(undefined);
    try {
      return await action();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(undefined) };
}
