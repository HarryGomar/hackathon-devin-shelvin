import { create } from 'zustand';

import { blocksByPage, withScrapeBlock } from '@/api/failure-codes';
import type { AgentRun, Job, JobProgress, JobStatus, ProductIdentity, ScanInput, ScanType, ScrapeFailure, ScrapeResult, SearchResult, SourcePage } from '@/api/types';

/** A scraper build the app follows: started from a row, by "Build all missing", from Add a page, or found running. */
export interface BuildEntry {
  jobId: string;
  domain: string;
  /** The page it was started for; other pages on the site share the build. */
  pageId?: string;
  status: JobStatus;
  /** The builder's live record (agent, stage, attempts, gate reports), from the job. */
  run?: AgentRun;
  progress?: JobProgress;
  error?: string;
}

/** State of the current scan flow: Home → Confirm → Pages found → Results. */
export interface SessionState {
  input?: ScanInput;
  identity?: ProductIdentity;
  scanType: ScanType;
  includeSimilar: boolean;
  searchJobId?: string;
  search?: SearchResult;
  /** Search pages plus user-added pages, with their current scraper status. */
  pages: SourcePage[];
  selectedPageIds: string[];
  /** Pages already scraped in this session, for "Scrape more sources". */
  scrapedPageIds: string[];
  /** Pages whose last scrape the site refused (blocked, robots): shown as refused in every search until scraped. */
  blockedPages: Record<string, ScrapeFailure>;
  lastScrape?: ScrapeResult;
  /**
   * Scraper builds by site (domain). Kept across scans: a build keeps running on the backend, and a site's scraper
   * (and which agent built it) is the same for every product.
   */
  builds: Record<string, BuildEntry>;

  startScan(input: ScanInput): void;
  setIdentity(product: ProductIdentity): void;
  /** Switch to a product that didn't come from the scan (a similar product): the scan input no longer describes it. */
  pickOtherProduct(product: ProductIdentity): void;
  /**
   * Start a new search for a saved product (no scan input). Its saved pages count as already scraped, and pages whose
   * last scrape the site refused (`failures`) stay refused.
   */
  resumeProduct(product: ProductIdentity, savedPageIds: string[], failures?: ScrapeFailure[]): void;
  setScanOptions(options: { scanType?: ScanType; includeSimilar?: boolean }): void;
  setSearchJobId(jobId: string | undefined): void;
  setSearch(result: SearchResult): void;
  upsertPage(page: SourcePage): void;
  togglePage(id: string): void;
  setSelectedPageIds(ids: string[]): void;
  setScrapeResult(result: ScrapeResult): void;
  /** Follow a build job for a site; a new job for the site replaces the old entry. */
  trackBuild(domain: string, jobId: string, pageId?: string): void;
  /** The latest poll of a build job. Ignored when the site has moved on to another job. */
  updateBuild(domain: string, job: Job<unknown>, error?: string): void;
  reset(): void;
}

const initial = {
  input: undefined,
  identity: undefined,
  scanType: 'both' as ScanType,
  includeSimilar: true,
  searchJobId: undefined,
  search: undefined,
  pages: [],
  selectedPageIds: [],
  scrapedPageIds: [],
  blockedPages: {},
  lastScrape: undefined,
};

/** Selected by default: verified (or user-added) pages that have a scraper, the site allows, and weren't scraped yet. */
export function isDefaultSelected(page: SourcePage, scrapedPageIds: string[]) {
  return (
    page.scraper.status === 'available' &&
    page.access?.status !== 'refused' &&
    (page.verification.status === 'verified' || page.verification.status === 'user_added') &&
    !scrapedPageIds.includes(page.id)
  );
}

/** Identity fields a search depends on. Editing any of them means the old search no longer applies. */
const SEARCH_FIELDS = ['id', 'brand', 'productName', 'variant', 'size', 'barcode'] as const;

export function sameSearchIdentity(a: ProductIdentity, b: ProductIdentity) {
  return SEARCH_FIELDS.every((k) => a[k] === b[k]);
}

export const useSession = create<SessionState>()((set, get) => ({
  ...initial,
  builds: {},

  startScan: (input) => set({ ...initial, input }),

  // A different product (or a change to any field the search uses) invalidates the previous search.
  setIdentity: (product) =>
    set((s) =>
      s.identity && sameSearchIdentity(s.identity, product)
        ? { identity: product }
        : { identity: product, searchJobId: undefined, search: undefined, pages: [], selectedPageIds: [], scrapedPageIds: [], blockedPages: {}, lastScrape: undefined },
    ),

  pickOtherProduct: (product) => {
    get().setIdentity(product);
    set({ input: undefined });
  },

  resumeProduct: (product, savedPageIds, failures = []) =>
    set({ ...initial, identity: product, scrapedPageIds: [...new Set(savedPageIds)], blockedPages: blocksByPage(failures) }),

  setScanOptions: (options) =>
    set((s) => {
      const changed =
        (options.scanType !== undefined && options.scanType !== s.scanType) ||
        (options.includeSimilar !== undefined && options.includeSimilar !== s.includeSimilar);
      return changed
        ? { ...options, searchJobId: undefined, search: undefined, pages: [], selectedPageIds: [] }
        : options;
    }),

  setSearchJobId: (jobId) => set({ searchJobId: jobId }),

  setSearch: (result) =>
    set((s) => {
      const pages = result.pages.map((p) => withScrapeBlock(p, s.blockedPages[p.id]));
      return {
        search: result,
        pages,
        selectedPageIds: pages.filter((p) => isDefaultSelected(p, s.scrapedPageIds)).map((p) => p.id),
      };
    }),

  upsertPage: (page) =>
    set((s) => {
      const exists = s.pages.some((p) => p.id === page.id);
      const pages = exists ? s.pages.map((p) => (p.id === page.id ? page : p)) : [...s.pages, page];
      const selectedPageIds =
        isDefaultSelected(page, s.scrapedPageIds) && !s.selectedPageIds.includes(page.id)
          ? [...s.selectedPageIds, page.id]
          : s.selectedPageIds;
      return { pages, selectedPageIds };
    }),

  togglePage: (id) =>
    set((s) => ({
      selectedPageIds: s.selectedPageIds.includes(id)
        ? s.selectedPageIds.filter((x) => x !== id)
        : [...s.selectedPageIds, id],
    })),

  setSelectedPageIds: (ids) => set({ selectedPageIds: ids }),

  // A page the site refused during the scrape (401/403/429, robots) becomes refused here too, so "Scrape more sources"
  // doesn't offer it again; a page that now has a listing is no longer blocked.
  setScrapeResult: (result) =>
    set((s) => {
      const blockedPages = { ...s.blockedPages, ...blocksByPage(result.failures) };
      for (const l of result.listings) delete blockedPages[l.pageId];
      return {
        lastScrape: result,
        scrapedPageIds: [...new Set([...s.scrapedPageIds, ...result.listings.map((l) => l.pageId)])],
        blockedPages,
        pages: s.pages.map((p) => withScrapeBlock(p, blockedPages[p.id])),
        selectedPageIds: [],
      };
    }),

  trackBuild: (domain, jobId, pageId) =>
    set((s) => (s.builds[domain]?.jobId === jobId ? s : { builds: { ...s.builds, [domain]: { jobId, domain, pageId, status: 'queued' } } })),

  updateBuild: (domain, job, error) =>
    set((s) => {
      const entry = s.builds[domain];
      if (!entry || entry.jobId !== job.jobId) return s;
      const status: JobStatus = error && job.status !== 'succeeded' ? 'failed' : job.status;
      const next: BuildEntry = { ...entry, status, run: job.agentRun ?? entry.run, progress: job.progress ?? entry.progress, error: error ?? job.error };
      return { builds: { ...s.builds, [domain]: next } };
    }),

  reset: () => set(initial),
}));
