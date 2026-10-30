import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { getApi } from '@/api/client';
import type { BuildDetail, BuildHistory } from '@/api/types';

import { anyActive, isActive } from './format';

const POLL_MS = 3000;

interface Loaded<T> {
  key: string;
  data?: T;
  error?: string;
}

/**
 * Loads `load(key)` while the screen is focused, then again every `intervalMs` (3 s) while `keepPolling(data)` holds.
 * `refresh` (pull to refresh, retry) loads now and restarts the polling. On an error what's on screen stays, with the error.
 */
export function usePolled<T>(key: string, load: (key: string) => Promise<T>, keepPolling: (data: T) => boolean, intervalMs = POLL_MS) {
  const focused = useIsFocused();
  const [round, setRound] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T>>();
  const [refreshing, setRefreshing] = useState(false);

  // `round` is only a dependency: bumping it restarts the loop.
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const data = await load(key);
        if (cancelled) return;
        setLoaded({ key, data });
        if (keepPolling(data)) timer = setTimeout(poll, intervalMs);
      } catch (e) {
        if (cancelled) return;
        const error = e instanceof Error ? e.message : String(e);
        setLoaded((prev) => ({ key, data: prev?.key === key ? prev.data : undefined, error }));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [focused, key, round, load, keepPolling, intervalMs]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRound((n) => n + 1);
  }, []);

  // Ignore an answer left over from another key.
  const current = loaded?.key === key ? loaded : undefined;
  return { data: current?.data, error: current?.error, refreshing, refresh };
}

const loadHistory = () => getApi().listBuilds();
const historyActive = (history: BuildHistory) => anyActive(history.builds) || history.totals.running > 0;

/** GET /builds, polled while any build is queued or running. */
export function useBuildHistory() {
  return usePolled('builds', loadHistory, historyActive);
}

const loadBuild = (buildId: string) => getApi().getBuild(buildId);
const buildActive = (build: BuildDetail) => isActive(build.state);

/** GET /builds/:buildId, polled until the build ends. */
export function useBuild(buildId: string) {
  return usePolled(buildId, loadBuild, buildActive);
}
