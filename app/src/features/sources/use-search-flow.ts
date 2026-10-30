import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getApi } from '@/api/client';
import type { SearchResult, SourcePage } from '@/api/types';
import { useJob } from '@/hooks/use-job';
import { sameSearchIdentity, useSession } from '@/state/session';

import { errorText } from './errors';

export type SearchPhase =
  | { kind: 'no-product' }
  | { kind: 'searching'; step?: string; message?: string }
  | { kind: 'matching' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

/**
 * Runs the search for the current identity once: startSearch → poll the job → matchScrapers → setSearch.
 * Does nothing while a search is already stored, so coming back to the screen never re-runs it.
 * Only starts while the screen is focused. Call `pause()` right before changing the identity and navigating away
 * (picking a similar product), so the search for the new product starts when this screen is shown again, not behind Confirm.
 */
export function useSearchFlow() {
  const identity = useSession((s) => s.identity);
  const search = useSession((s) => s.search);
  const searchJobId = useSession((s) => s.searchJobId);
  const scanType = useSession((s) => s.scanType);
  const includeSimilar = useSession((s) => s.includeSimilar);
  const setSearchJobId = useSession((s) => s.setSearchJobId);
  const setSearch = useSession((s) => s.setSearch);

  const { job, error: jobError } = useJob<SearchResult>(searchJobId);
  const [startError, setStartError] = useState<string>();
  const [matchError, setMatchError] = useState<{ jobId: string; message: string }>();
  const starting = useRef(false);
  const matchedJobId = useRef<string | undefined>(undefined);
  const focused = useIsFocused();
  const [paused, setPaused] = useState(false);
  useFocusEffect(useCallback(() => setPaused(false), []));
  const pause = useCallback(() => setPaused(true), []);
  const enabled = focused && !paused;

  const start = useCallback(() => {
    if (!identity || starting.current) return;
    starting.current = true;
    getApi()
      .startSearch({ product: identity, scanType, includeSimilar, region: 'MX' })
      .then(
        (created) => {
          // The user may have switched product while the request was in flight.
          const now = useSession.getState();
          if (now.identity && sameSearchIdentity(now.identity, identity) && !now.search) setSearchJobId(created.jobId);
        },
        (e: unknown) => setStartError(errorText(e)),
      )
      .finally(() => {
        starting.current = false;
      });
  }, [identity, scanType, includeSimilar, setSearchJobId]);

  const match = useCallback(
    async (jobId: string, result: SearchResult) => {
      matchedJobId.current = jobId;
      try {
        const matches = await getApi().matchScrapers(result.pages.map((p) => p.url));
        const byUrl = new Map(matches.map((m) => [m.url, m]));
        // A build already running for a site (started earlier, or by someone else): follow it.
        const { builds, trackBuild } = useSession.getState();
        for (const m of matches) {
          if (m.status === 'building' && m.buildJobId && builds[m.domain]?.jobId !== m.buildJobId) trackBuild(m.domain, m.buildJobId);
        }
        const pages = result.pages.map((p): SourcePage => {
          const m = byUrl.get(p.url);
          return m ? { ...p, scraper: { status: m.status, scraperId: m.scraperId } } : p;
        });
        if (useSession.getState().searchJobId === jobId) setSearch({ ...result, pages });
      } catch (e) {
        setMatchError({ jobId, message: errorText(e) });
      }
    },
    [setSearch],
  );

  useEffect(() => {
    if (enabled && identity && !search && !searchJobId && !startError) start();
  }, [enabled, identity, search, searchJobId, startError, start]);

  const succeeded = job?.status === 'succeeded' && job.result ? job : undefined;
  useEffect(() => {
    if (succeeded?.result && !search && matchedJobId.current !== succeeded.jobId) match(succeeded.jobId, succeeded.result);
  }, [succeeded, search, match]);

  const retry = useCallback(() => {
    if (matchError && succeeded?.result && matchError.jobId === succeeded.jobId) {
      setMatchError(undefined);
      match(succeeded.jobId, succeeded.result);
      return;
    }
    setMatchError(undefined);
    setStartError(undefined);
    setSearchJobId(undefined);
  }, [matchError, succeeded, match, setSearchJobId]);

  let phase: SearchPhase;
  if (!identity) phase = { kind: 'no-product' };
  else if (search) phase = { kind: 'ready' };
  else if (startError) phase = { kind: 'error', message: startError };
  else if (jobError) phase = { kind: 'error', message: jobError };
  else if (matchError && matchError.jobId === searchJobId) phase = { kind: 'error', message: matchError.message };
  else if (succeeded) phase = { kind: 'matching' };
  else phase = { kind: 'searching', step: job?.progress?.step, message: job?.progress?.message };

  return { phase, retry, pause };
}
