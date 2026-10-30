import { useEffect, useState } from 'react';

import { getApi } from '@/api/client';
import type { Job } from '@/api/types';

const POLL_MS = 1000;

interface PollState<T> {
  jobId: string;
  job?: Job<T>;
  error?: string;
}

/** Polls GET /jobs/:id every second until the job succeeds or fails. Pass undefined to idle. */
export function useJob<T>(jobId: string | undefined) {
  const [state, setState] = useState<PollState<T> | undefined>();

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await getApi().getJob<T>(jobId);
        if (cancelled) return;
        setState({ jobId, job: next, error: next.status === 'failed' ? (next.error ?? 'Something went wrong') : undefined });
        if (next.status === 'queued' || next.status === 'running') timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!cancelled) setState({ jobId, error: e instanceof Error ? e.message : String(e) });
      }
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  // Ignore results left over from a previous job id.
  const current = state && state.jobId === jobId ? state : undefined;
  const job = current?.job;
  const error = current?.error;
  const isDone = job?.status === 'succeeded' || job?.status === 'failed' || error !== undefined;
  return { job, isDone, error };
}
