import type { FetchFailureCode, ScrapeFailure, SourcePage } from './types';

/**
 * The site said no (robots.txt, its AI-agent opt-out, or 401/403/429). These are never retried or worked around.
 * `rate_limited` is not here on purpose: slowing down is temporary, so that page stays retryable (Couldn't fetch).
 */
const BLOCKED: ReadonlySet<string> = new Set<FetchFailureCode>(['ai_opt_out', 'robots_disallow', 'robots_unavailable', 'blocked']);

/** Whether a failure or access `code` means the site refused us. Unknown codes are not guessed as blocked. */
export function isBlockedCode(code: string | undefined): boolean {
  return code !== undefined && BLOCKED.has(code);
}

/**
 * A page whose last scrape the site refused counts as refused (not selectable, shown BLOCKED), even when the search
 * found its robots.txt allows it: a 401/403/429 isn't in robots.txt. A refusal the page already carries wins.
 */
export function withScrapeBlock(page: SourcePage, block: ScrapeFailure | undefined): SourcePage {
  if (!block || page.access?.status === 'refused') return page;
  return { ...page, access: { status: 'refused', code: block.code ?? 'blocked', reason: block.error } };
}

/** The blocking failures, by page id. */
export function blocksByPage(failures: ScrapeFailure[]): Record<string, ScrapeFailure> {
  return Object.fromEntries(failures.filter((f) => isBlockedCode(f.code)).map((f) => [f.pageId, f]));
}
