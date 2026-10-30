import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getApi } from '@/api/client';
import type { ScrapeResult } from '@/api/types';
import { useJob } from '@/hooks/use-job';
import { useSession } from '@/state/session';

import { errorText } from './errors';

/** startScrape → poll the job → setScrapeResult → /results. */
export function useScrapeFlow() {
  const setScrapeResult = useSession((s) => s.setScrapeResult);
  const [jobId, setJobId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const { job, isDone, error: jobError } = useJob<ScrapeResult>(jobId);
  const handled = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (job?.status === 'succeeded' && job.result && handled.current !== job.jobId) {
      handled.current = job.jobId;
      setScrapeResult(job.result);
      router.push('/results');
    }
  }, [job, setScrapeResult]);

  const start = useCallback(async (pageIds: string[]) => {
    const { search, identity } = useSession.getState();
    if (!search || !identity || pageIds.length === 0) return;
    setStarting(true);
    setStartError(undefined);
    setJobId(undefined);
    try {
      const created = await getApi().startScrape({ searchId: search.searchId, productId: identity.id, pageIds });
      setJobId(created.jobId);
    } catch (e) {
      setStartError(errorText(e));
    } finally {
      setStarting(false);
    }
  }, []);

  return {
    start,
    scraping: starting || (jobId !== undefined && !isDone),
    step: job?.progress?.step,
    message: job?.progress?.message,
    /** Each page's progress while the job runs (backend `Job.sites`). */
    sites: job?.sites,
    error: startError ?? jobError,
  };
}
