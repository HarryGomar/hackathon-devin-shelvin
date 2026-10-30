import type { BuildScraperResult, PageAccess, SourcePage } from '@/api/types';
import { useSession } from '@/state/session';

/** A page that can go into a scrape: has a scraper, the site doesn't refuse it, and the agent didn't reject it. */
export function isScrapable(page: SourcePage) {
  return page.scraper.status === 'available' && page.access?.status !== 'refused' && page.verification.status !== 'rejected';
}

/** The site refuses automated collection (robots.txt, or its rule for AI agents). */
export function isRefused(page: SourcePage) {
  return page.access?.status === 'refused';
}

/** Sites a build would help: no scraper yet, allowed, not rejected; one page per site, in list order. */
export function buildablePages(pages: SourcePage[]) {
  const seen = new Set<string>();
  return pages.filter((p) => {
    if (p.scraper.status === 'available' || isRefused(p) || p.verification.status === 'rejected' || seen.has(p.domain)) return false;
    seen.add(p.domain);
    return true;
  });
}

/**
 * The pages "Build all missing" sends: every accepted page without a scraper, refused ones included, so the
 * backend's `skipped[]` says why those get no build.
 */
export function batchBuildPageIds(pages: SourcePage[]) {
  return pages.filter((p) => p.scraper.status !== 'available' && p.verification.status !== 'rejected').map((p) => p.id);
}

/** Remember that the site refused a page (a scraper build it turned down), so the row shows it as blocked. */
export function applyRefusal(page: SourcePage, access: PageAccess) {
  useSession.getState().upsertPage({ ...page, scraper: { status: 'missing' }, access });
}

/** Store a freshly built scraper: the page it was built for, plus every other page on the same site. */
export function applyBuiltScraper(result: BuildScraperResult) {
  const { pages, upsertPage } = useSession.getState();
  upsertPage(result.page);
  for (const p of pages) {
    if (p.id !== result.page.id && p.domain === result.domain && p.scraper.status !== 'available') {
      upsertPage({ ...p, scraper: { status: 'available', scraperId: result.scraperId } });
    }
  }
}

const URL_PATTERN = /^https?:\/\/[^\s/?#]+\.[^\s/?#]{2,}([/?#]\S*)?$/i;

export function isValidPageUrl(text: string) {
  return URL_PATTERN.test(text.trim());
}
