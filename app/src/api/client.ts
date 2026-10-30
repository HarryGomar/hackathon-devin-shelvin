import { hasClaudeKey } from '@/services/claude/client';

import { ClaudeSearchApi } from './claude-search';
import { HttpApi } from './http';
import { MockApi } from './mock';
import type {
  AgentEvent,
  AgentRun,
  BuildBatchRequest,
  BuildBatchResult,
  BuildChanges,
  BuildDetail,
  BuildHistory,
  BuildMessageRequest,
  BuildQuery,
  BuildRetryRequest,
  BuildRetryResult,
  BuildScraperRequest,
  BuildScraperResult,
  DecisionLibrary,
  DecisionRequest,
  DecisionResult,
  Health,
  Job,
  ProductDetail,
  ProductIdentity,
  ProductList,
  ProductListings,
  ProductQuery,
  ScanSummary,
  ScraperMatch,
  ScrapeRequest,
  ScrapeResult,
  SearchRequest,
  SearchResult,
  SessionInsights,
} from './types';

/** One method per backend endpoint (docs/api-contract.md). */
export interface ProductApi {
  /** POST /search */
  startSearch(req: SearchRequest): Promise<Job<SearchResult>>;
  /** POST /scrapers/match */
  matchScrapers(urls: string[]): Promise<ScraperMatch[]>;
  /** POST /scrapers/build */
  startBuildScraper(req: BuildScraperRequest): Promise<Job<BuildScraperResult>>;
  /** POST /scrapers/build-batch: one build per site without a scraper, run in parallel. */
  startBuildBatch(req: BuildBatchRequest): Promise<BuildBatchResult>;
  /** POST /scrape */
  startScrape(req: ScrapeRequest): Promise<Job<ScrapeResult>>;
  /** GET /jobs/:jobId */
  getJob<T>(jobId: string): Promise<Job<T>>;
  /** GET /scans */
  listScans(): Promise<ScanSummary[]>;
  /** GET /products/:productId/listings */
  getProductListings(productId: string): Promise<ProductListings>;
  /** GET /builds: build history (every recorded build and a per-site tally) */
  listBuilds(query?: BuildQuery): Promise<BuildHistory>;
  /** GET /builds/:buildId */
  getBuild(buildId: string): Promise<BuildDetail>;
  // The console: steer a build. A control that isn't possible now fails with 409 `not_available` and says why.
  /** POST /builds/:buildId/messages: the person event; Devin's reply arrives later in GET /builds/:buildId. */
  messageBuild(buildId: string, req: BuildMessageRequest): Promise<AgentEvent>;
  /** POST /builds/:buildId/stop: the build; it becomes 'stopped' within seconds. */
  stopBuild(buildId: string, by?: string): Promise<AgentRun>;
  /** POST /builds/:buildId/retry: a new build that continues this one. */
  retryBuild(buildId: string, req: BuildRetryRequest): Promise<BuildRetryResult>;
  /** POST /builds/:buildId/gate: the request event; the manual gate's result arrives later as a 'gate' event. */
  gateBuild(buildId: string, by?: string): Promise<AgentEvent>;
  /** GET /builds/:buildId/changes */
  getBuildChanges(buildId: string): Promise<BuildChanges>;
  /** GET /builds/:buildId/insights */
  getBuildInsights(buildId: string): Promise<SessionInsights>;
  /** POST /builds/:buildId/insights: generation started; poll getBuildInsights until completed or failed. */
  generateBuildInsights(buildId: string, by?: string): Promise<SessionInsights>;
  /** POST /builds/:buildId/decisions: confirm a decision or change it. */
  decideBuild(buildId: string, req: DecisionRequest): Promise<DecisionResult>;
  /** GET /decisions?reader= */
  listDecisions(query?: { reader?: string }): Promise<DecisionLibrary>;
  // Optional: the backend has them; the app's flow doesn't need them.
  /** GET /health */
  getHealth?(): Promise<Health>;
  /** POST /products (save or update a confirmed product) */
  saveProduct?(product: ProductIdentity): Promise<ProductIdentity>;
  /** GET /products */
  listProducts?(query?: ProductQuery): Promise<ProductList>;
  /** GET /products/:productId */
  getProduct?(productId: string): Promise<ProductDetail>;
}

export type ApiMode = 'mock' | 'live';

const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

/** `live` needs EXPO_PUBLIC_API_BASE_URL too; without it the app stays on the mock (and says so). */
export const apiMode: ApiMode = process.env.EXPO_PUBLIC_API_MODE === 'live' && baseUrl ? 'live' : 'mock';

export type SearchMode = 'mock' | 'claude';

/**
 * `claude` (needs the key, and only while the backend is mocked): page search is a real Claude web search run in
 * the app; scrapers stay mocked. Each search costs money (see .env.example).
 */
export const searchMode: SearchMode =
  apiMode === 'mock' && process.env.EXPO_PUBLIC_SEARCH_MODE === 'claude' && hasClaudeKey ? 'claude' : 'mock';

let instance: ProductApi | undefined;

export function getApi(): ProductApi {
  if (!instance) {
    if (apiMode === 'live' && baseUrl) instance = new HttpApi(baseUrl, { token: process.env.EXPO_PUBLIC_API_TOKEN || undefined });
    else if (searchMode === 'claude') instance = new ClaudeSearchApi(new MockApi());
    else instance = new MockApi();
  }
  return instance;
}
