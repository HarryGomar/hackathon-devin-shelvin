import { useEffect, useRef } from 'react';

import type { BuildScraperResult, SourcePage } from '@/api/types';
import { useJob } from '@/hooks/use-job';
import { useSession, type BuildEntry } from '@/state/session';

import { buildRefusal } from './build-run';
import { applyBuiltScraper, applyRefusal } from './pages';

/**
 * Polls every running scraper build in the session, one poller per build, whatever screen is showing. Mounted once
 * in the root layout, so a build started on Pages found or Add a page keeps updating its rows.
 */
export function BuildWatchers() {
  const builds = useSession((s) => s.builds);
  const running = Object.values(builds).filter((b) => b.status === 'queued' || b.status === 'running');
  return (
    <>
      {running.map((b) => (
        <BuildWatcher key={b.jobId} entry={b} />
      ))}
    </>
  );
}

function BuildWatcher({ entry }: { entry: BuildEntry }) {
  const { job, error } = useJob<BuildScraperResult>(entry.jobId);
  const applied = useRef(false);

  useEffect(() => {
    if (!job && !error) return;
    const { updateBuild, pages } = useSession.getState();
    if (job && !applied.current) {
      // A passed build makes every page on the site scrapable; a refusal marks the site's pages as refused.
      if (job.status === 'succeeded' && job.result) {
        applied.current = true;
        applyBuiltScraper(job.result);
      }
      const access = job.status === 'failed' ? buildRefusal(job.agentRun) : undefined;
      if (access) {
        applied.current = true;
        for (const p of pages.filter((x: SourcePage) => x.domain === entry.domain)) applyRefusal(p, access);
      }
    }
    updateBuild(entry.domain, job ?? { jobId: entry.jobId, status: 'failed' }, error);
  }, [job, error, entry.domain, entry.jobId]);

  return null;
}
