import { withProductPhoto } from '@/services/photo';
import { retailerFor, searchPagesWithClaude, SEARCH_TIMEOUT_MS } from '@/services/search';

import type { ProductApi } from './client';
import type { MockApi } from './mock';
import type {
  BuildBatchRequest,
  BuildMessageRequest,
  BuildQuery,
  BuildRetryRequest,
  DecisionRequest,
  BuildScraperRequest,
  Job,
  JobProgress,
  ScrapeRequest,
  SearchRequest,
  SearchResult,
} from './types';

interface LocalJob {
  createdAt: number;
  job: Job<SearchResult>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep the quick verify / rank steps on screen for a moment (the app polls once a second). */
const STEP_HOLD_MS = 900;

/**
 * Hybrid backend (`EXPO_PUBLIC_SEARCH_MODE=claude`): `POST /search` is a real Claude web search run in the app as a
 * job; scrapers, scrapes, scans and listings stay on the mock, which is given the real pages.
 */
export class ClaudeSearchApi implements ProductApi {
  private jobs = new Map<string, LocalJob>();
  private counter = 0;

  constructor(private readonly mock: MockApi) {}

  async startSearch(req: SearchRequest): Promise<Job<SearchResult>> {
    this.counter += 1;
    const jobId = `claude-search-${Date.now().toString(36)}-${this.counter}`;
    const progress: JobProgress = { step: 'search', message: `Searching Mexican stores for ${req.product.productName}`, percent: 5 };
    const local: LocalJob = { createdAt: Date.now(), job: { jobId, status: 'running', progress } };
    this.jobs.set(jobId, local);
    this.run(local, req);
    return { ...local.job };
  }

  private async run(local: LocalJob, req: SearchRequest) {
    const setProgress = (p: JobProgress) => {
      local.job = { ...local.job, progress: p };
    };
    // A photo for a product that has none, from Open Food Facts (free), alongside the search.
    const product = withProductPhoto(req.product);
    try {
      const found = await searchPagesWithClaude(req, { onProgress: setProgress });
      const sites = new Set(found.pages.map((p) => p.domain)).size;
      setProgress({ step: 'verify', message: `Found ${found.pages.length} page(s) on ${sites} site(s); checking each is the same product`, percent: 80 });
      await wait(STEP_HOLD_MS);
      setProgress({ step: 'rank', message: 'Ranking official pages and retailers', percent: 92 });
      const result = this.mock.registerSearch(
        { searchId: `search-claude-${local.job.jobId}`, product: await product, pages: found.pages, similarProducts: found.similarProducts },
        (domain) => retailerFor(domain)?.key,
      );
      await wait(STEP_HOLD_MS);
      local.job = { jobId: local.job.jobId, status: 'succeeded', result, progress: { step: 'done', message: 'Done', percent: 100 } };
    } catch (e) {
      local.job = { ...local.job, status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getJob<T>(jobId: string): Promise<Job<T>> {
    const local = this.jobs.get(jobId);
    if (!local) return this.mock.getJob<T>(jobId);
    const { job } = local;
    if (job.status === 'running' && job.progress?.step === 'search') {
      // No streaming here, so the search step's bar follows the clock (up to 70%).
      const share = Math.min(1, (Date.now() - local.createdAt) / SEARCH_TIMEOUT_MS);
      return { ...job, progress: { ...job.progress, percent: Math.round(5 + share * 65) } } as Job<T>;
    }
    return { ...job } as Job<T>;
  }

  matchScrapers(urls: string[]) {
    return this.mock.matchScrapers(urls);
  }

  startBuildScraper(req: BuildScraperRequest) {
    return this.mock.startBuildScraper(req);
  }

  startBuildBatch(req: BuildBatchRequest) {
    return this.mock.startBuildBatch(req);
  }

  startScrape(req: ScrapeRequest) {
    return this.mock.startScrape(req);
  }

  listScans() {
    return this.mock.listScans();
  }

  getProductListings(productId: string) {
    return this.mock.getProductListings(productId);
  }

  getHealth() {
    return this.mock.getHealth();
  }

  listBuilds(query?: BuildQuery) {
    return this.mock.listBuilds(query);
  }

  getBuild(buildId: string) {
    return this.mock.getBuild(buildId);
  }

  messageBuild(buildId: string, req: BuildMessageRequest) {
    return this.mock.messageBuild(buildId, req);
  }

  stopBuild(buildId: string, by?: string) {
    return this.mock.stopBuild(buildId, by);
  }

  retryBuild(buildId: string, req: BuildRetryRequest) {
    return this.mock.retryBuild(buildId, req);
  }

  gateBuild(buildId: string, by?: string) {
    return this.mock.gateBuild(buildId, by);
  }

  getBuildChanges(buildId: string) {
    return this.mock.getBuildChanges(buildId);
  }

  getBuildInsights(buildId: string) {
    return this.mock.getBuildInsights(buildId);
  }

  generateBuildInsights(buildId: string, by?: string) {
    return this.mock.generateBuildInsights(buildId, by);
  }

  decideBuild(buildId: string, req: DecisionRequest) {
    return this.mock.decideBuild(buildId, req);
  }

  listDecisions(query?: { reader?: string }) {
    return this.mock.listDecisions(query);
  }
}
