import type { ProductApi } from './client';
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
  ScanInput,
  ScanSummary,
  ScraperMatch,
  ScrapeRequest,
  ScrapeResult,
  SearchRequest,
  SearchResult,
  SessionInsights,
} from './types';

/** A failed backend call. `message` is short and readable: the Confirm and Sources screens show it as is. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  /** `status` 0 means no HTTP answer (timeout or network failure). */
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The app's budget per request (docs/backend-spec.md §2 Timeouts). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** `POST /identify` is synchronous and runs Claude; the server keeps it under 25 s. */
export const IDENTIFY_TIMEOUT_MS = 30_000;

export const TIMEOUT_MESSAGE = 'The server took too long to answer. Check your connection and try again.';
export const NETWORK_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

/** `POST /identify` body: the scan without the photo's device-local `uri`. */
export type IdentifyRequest =
  | Extract<ScanInput, { kind: 'barcode' }>
  | Extract<ScanInput, { kind: 'manual' }>
  | Omit<Extract<ScanInput, { kind: 'photo' }>, 'uri'>;

export function identifyRequestBody(input: ScanInput): IdentifyRequest {
  if (input.kind === 'photo') return { kind: 'photo', base64: input.base64, mimeType: input.mimeType };
  if (input.kind === 'barcode') {
    return input.format ? { kind: 'barcode', code: input.code, format: input.format } : { kind: 'barcode', code: input.code };
  }
  return { kind: 'manual', code: input.code };
}

/** Request headers: the team token (when set) and, with a body, the JSON content type. */
export function buildHeaders(token: string | undefined, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * The message and code from an error body. The contract is `{ error: string, code? }`; the old nested
 * `{ error: { code, message } }` is accepted too. Anything else gives `fallback`.
 */
export function parseErrorBody(body: unknown, fallback: string): { message: string; code?: string } {
  if (!body || typeof body !== 'object') return { message: fallback };
  const { error, code } = body as { error?: unknown; code?: unknown };
  const topCode = typeof code === 'string' && code ? code : undefined;
  if (typeof error === 'string' && error.trim()) return { message: error.trim(), code: topCode };
  if (error && typeof error === 'object') {
    const nested = error as { message?: unknown; code?: unknown };
    const nestedCode = typeof nested.code === 'string' && nested.code ? nested.code : topCode;
    if (typeof nested.message === 'string' && nested.message.trim()) return { message: nested.message.trim(), code: nestedCode };
    return { message: fallback, code: nestedCode };
  }
  return { message: fallback, code: topCode };
}

/** `?a=1&b=x` from the set fields of a query (undefined and empty strings left out), or '' when none are set. */
export function queryString(query: object): string {
  const params = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return params ? `?${params}` : '';
}

export interface HttpApiOptions {
  /** Team token sent as `Authorization: Bearer …` (EXPO_PUBLIC_API_TOKEN). */
  token?: string;
  requestTimeoutMs?: number;
  identifyTimeoutMs?: number;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Real backend client. Paths match docs/api-contract.md and docs/backend-spec.md. */
export class HttpApi implements ProductApi {
  private readonly baseUrl: string;
  private readonly options: HttpApiOptions;

  constructor(baseUrl: string, options: HttpApiOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.options = options;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const fetchFn = this.options.fetch ?? fetch;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs ?? this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers: buildHeaders(this.options.token, body !== undefined),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new ApiError(timedOut ? TIMEOUT_MESSAGE : NETWORK_MESSAGE, 0, timedOut ? 'timeout' : 'network');
      }
      if (!res.ok) {
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch {
          // body was not JSON; keep the generic message
        }
        const { message, code } = parseErrorBody(parsed, `${method} ${path} failed (${res.status})`);
        throw new ApiError(message, res.status, code);
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new ApiError(timedOut ? TIMEOUT_MESSAGE : `${method} ${path} returned an unreadable answer`, timedOut ? 0 : res.status, timedOut ? 'timeout' : 'invalid_response');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /identify. Synchronous; gets the longer timeout. */
  identify(input: ScanInput) {
    return this.request<ProductIdentity>(
      'POST',
      '/identify',
      identifyRequestBody(input),
      this.options.identifyTimeoutMs ?? IDENTIFY_TIMEOUT_MS,
    );
  }

  startSearch(req: SearchRequest) {
    return this.request<Job<SearchResult>>('POST', '/search', req);
  }

  async matchScrapers(urls: string[]) {
    const res = await this.request<{ matches: ScraperMatch[] }>('POST', '/scrapers/match', { urls });
    return res.matches;
  }

  startBuildScraper(req: BuildScraperRequest) {
    return this.request<Job<BuildScraperResult>>('POST', '/scrapers/build', req);
  }

  startBuildBatch(req: BuildBatchRequest) {
    return this.request<BuildBatchResult>('POST', '/scrapers/build-batch', req);
  }

  startScrape(req: ScrapeRequest) {
    return this.request<Job<ScrapeResult>>('POST', '/scrape', req);
  }

  getJob<T>(jobId: string) {
    return this.request<Job<T>>('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  async listScans() {
    const res = await this.request<{ scans: ScanSummary[] }>('GET', '/scans');
    return res.scans;
  }

  getProductListings(productId: string) {
    return this.request<ProductListings>('GET', `/products/${encodeURIComponent(productId)}/listings`);
  }

  getHealth() {
    return this.request<Health>('GET', '/health');
  }

  listBuilds(query: BuildQuery = {}) {
    return this.request<BuildHistory>('GET', `/builds${queryString(query)}`);
  }

  getBuild(buildId: string) {
    return this.request<BuildDetail>('GET', `/builds/${encodeURIComponent(buildId)}`);
  }

  private buildPath(buildId: string, tail: string) {
    return `/builds/${encodeURIComponent(buildId)}/${tail}`;
  }

  async messageBuild(buildId: string, req: BuildMessageRequest) {
    const res = await this.request<{ event: AgentEvent }>('POST', this.buildPath(buildId, 'messages'), req);
    return res.event;
  }

  async stopBuild(buildId: string, by?: string) {
    const res = await this.request<{ build: AgentRun }>('POST', this.buildPath(buildId, 'stop'), { by });
    return res.build;
  }

  retryBuild(buildId: string, req: BuildRetryRequest) {
    return this.request<BuildRetryResult>('POST', this.buildPath(buildId, 'retry'), req);
  }

  async gateBuild(buildId: string, by?: string) {
    const res = await this.request<{ event: AgentEvent }>('POST', this.buildPath(buildId, 'gate'), { by });
    return res.event;
  }

  getBuildChanges(buildId: string) {
    return this.request<BuildChanges>('GET', this.buildPath(buildId, 'changes'));
  }

  getBuildInsights(buildId: string) {
    return this.request<SessionInsights>('GET', this.buildPath(buildId, 'insights'));
  }

  generateBuildInsights(buildId: string, by?: string) {
    return this.request<SessionInsights>('POST', this.buildPath(buildId, 'insights'), { by });
  }

  decideBuild(buildId: string, req: DecisionRequest) {
    return this.request<DecisionResult>('POST', this.buildPath(buildId, 'decisions'), req);
  }

  listDecisions(query: { reader?: string } = {}) {
    return this.request<DecisionLibrary>('GET', `/decisions${queryString(query)}`);
  }

  async saveProduct(product: ProductIdentity) {
    const res = await this.request<{ product: ProductIdentity }>('POST', '/products', { product });
    return res.product;
  }

  listProducts(query: ProductQuery = {}) {
    return this.request<ProductList>('GET', `/products${queryString(query)}`);
  }

  getProduct(productId: string) {
    return this.request<ProductDetail>('GET', `/products/${encodeURIComponent(productId)}`);
  }
}
