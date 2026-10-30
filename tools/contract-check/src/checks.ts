/**
 * Identification runs in the app (no /identify on the backend), so the search sends a sample confirmed product.
 * Runs the contract against a server, in the order the app uses it (docs/backend-spec.md §"Acceptance"):
 * health → auth → error format → scans → search job → scrapers/match → scrapers/build job → scrape job
 * (twice, to check the merge by pageId) → scans → product listings.
 */
import { STEP_KEYS, type JobKind } from './extra-types.ts';
import type { BuildScraperResult, Job, ProductIdentity, ScrapeRequest, ScrapeResult, SearchRequest, SearchResult, SourcePage } from './types.ts';
import {
  checkBuildResult,
  checkErrorBody,
  checkHealth,
  checkJob,
  checkProductListings,
  checkScans,
  checkScraperMatches,
  checkScrapeResult,
  checkSearchResult,
  Issues,
  type Issue,
} from './validate.ts';

export interface CheckOptions {
  baseUrl: string;
  token?: string;
  /** How often to poll GET /jobs/:id (the app uses 1000). */
  pollMs?: number;
  /** Give up on a job after this long. */
  jobTimeoutMs?: number;
  /** false skips search, build and scrape (they cost money on a real server). */
  search?: boolean;
  /** The confirmed product to search for (default: Doritos Nacho 61 g). */
  product?: ProductIdentity;
  /** Called as each check finishes. */
  onResult?: (r: CheckResult) => void;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  issues: Issue[];
  ms?: number;
  note?: string;
}

/** The app gives up waiting on a plain request after 20 s. */
export const REQUEST_BUDGET_MS = 20_000;
const HARD_TIMEOUT_MS = 60_000;

interface Reply {
  status: number;
  body: unknown;
  text: string;
  ms: number;
  headers: Headers;
}

/** The confirmed product the app sends to /search (identification runs on the phone). */
const SAMPLE_PRODUCT: ProductIdentity = {
  id: 'gtin-07501011123588',
  brand: 'Doritos',
  productName: 'Doritos Nacho',
  variant: 'Nacho',
  size: '61 g',
  barcode: '7501011123588',
  manufacturer: 'Sabritas (PepsiCo México)',
  confidence: 0.9,
  source: 'claude',
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The id the backend keeps a product under (docs/api-contract.md, app/src/services/identify/gtin.ts): `gtin-` + the
 * GTIN-14 of a valid barcode, else the id the app sent. GET /scans and GET /products/:id show this one.
 */
export function canonicalProductId(product: ProductIdentity): string {
  let digits = (product.barcode ?? '').replace(/\D/g, '');
  while (digits.length > 14 && digits.startsWith('0')) digits = digits.slice(1);
  if (![8, 12, 13, 14].includes(digits.length)) return product.id;
  let sum = 0;
  for (let i = 1; i < digits.length; i++) sum += (digits.charCodeAt(digits.length - 1 - i) - 48) * (i % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]) ? `gtin-${digits.padStart(14, '0')}` : product.id;
}

export async function runChecks(opts: CheckOptions): Promise<CheckResult[]> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const pollMs = opts.pollMs ?? 1000;
  const jobTimeoutMs = opts.jobTimeoutMs ?? 150_000;
  const results: CheckResult[] = [];

  const call = async (method: 'GET' | 'POST' | 'OPTIONS', path: string, body?: unknown, headers: Record<string, string> | 'default' = 'default'): Promise<Reply> => {
    const h: Record<string, string> =
      headers === 'default' ? { Accept: 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) } : headers;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const started = Date.now();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text, ms: Date.now() - started, headers: res.headers };
  };

  /** Runs one check; a thrown error (network, timeout) is a failure of that check only. */
  const check = async (name: string, fn: (is: Issues, setNote: (n: string) => void) => Promise<number | void>): Promise<CheckResult> => {
    const is = new Issues();
    let note: string | undefined;
    let ms: number | undefined;
    try {
      ms = (await fn(is, (n) => (note = n))) ?? undefined;
    } catch (e) {
      is.error('', e instanceof Error ? `${e.name === 'TimeoutError' ? 'timed out: ' : ''}${e.message}` : String(e));
    }
    const status = is.hasErrors ? 'fail' : is.list.length > 0 ? 'warn' : 'pass';
    const r: CheckResult = { name, status, issues: is.list, ms, note };
    results.push(r);
    opts.onResult?.(r);
    return r;
  };

  const skip = (name: string, note: string) => {
    const r: CheckResult = { name, status: 'skip', issues: [], note };
    results.push(r);
    opts.onResult?.(r);
  };

  /** Status, JSON body and time budget of a 2xx reply. */
  const expectOk = (r: Reply, is: Issues, okStatuses: number[], budgetMs = REQUEST_BUDGET_MS) => {
    if (!okStatuses.includes(r.status)) is.error('status', `expected ${okStatuses.join(' or ')}, got ${r.status}: ${r.text.slice(0, 160)}`);
    if (r.body === undefined) is.error('body', 'is not JSON');
    const type = r.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) is.warn('content-type', `should be application/json, got ${JSON.stringify(type)}`);
    if (r.ms > budgetMs) is.error('time', `took ${r.ms} ms; the app expects an answer within ${budgetMs / 1000} s (make it a job)`);
  };

  const expectError = (r: Reply, is: Issues, status: number) => {
    if (r.status !== status) is.error('status', `expected ${status}, got ${r.status}: ${r.text.slice(0, 160)}`);
    checkErrorBody(r.body, 'body', is);
  };

  /** POST that starts a job, then poll it to the end. Returns the final job, or undefined. */
  const runJob = async <T>(kind: JobKind, path: string, body: unknown, is: Issues): Promise<Job<T> | undefined> => {
    const first = await call('POST', path, body);
    expectOk(first, is, [200, 202]);
    const start = checkJob(first.body, 'POST', is, kind);
    const jobId = (first.body as { jobId?: unknown } | undefined)?.jobId;
    if (typeof jobId !== 'string' || !start.status) return undefined;
    const seen: string[] = start.step ? [start.step] : [];
    let job = first.body as Job<T>;
    const deadline = Date.now() + jobTimeoutMs;
    let polls = 0;
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() > deadline) {
        is.error('job', `still ${job.status} after ${jobTimeoutMs / 1000} s`);
        return undefined;
      }
      await wait(pollMs);
      const r = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
      polls += 1;
      expectOk(r, is, [200], 5_000);
      const view = checkJob(r.body, `GET /jobs/${jobId}`, is, kind);
      if (!view.status) return undefined;
      if ((r.body as Job<T>).jobId !== jobId) is.error(`GET /jobs/${jobId}.jobId`, 'must stay the same while polling');
      if (view.step && seen.at(-1) !== view.step) seen.push(view.step);
      job = r.body as Job<T>;
    }
    const order = STEP_KEYS[kind];
    const indexes = seen.filter((s) => order.includes(s)).map((s) => order.indexOf(s));
    if (indexes.some((v, i) => i > 0 && v < indexes[i - 1])) is.warn('progress.step', `went backwards: ${seen.join(' → ')}`);
    if (polls > 0 && seen.length === 0) is.warn('progress', 'never present while polling');
    return job;
  };

  // 1. Health (no token).
  await check('GET /health', async (is) => {
    const r = await call('GET', '/health', undefined, { Accept: 'application/json' });
    expectOk(r, is, [200], 5_000);
    checkHealth(r.body, 'body', is);
    return r.ms;
  });

  // 2. Auth.
  if (opts.token) {
    await check('auth: no token / wrong token → 401', async (is) => {
      const none = await call('GET', '/scans', undefined, { Accept: 'application/json' });
      expectError(none, is, 401);
      const wrong = await call('GET', '/scans', undefined, { Accept: 'application/json', Authorization: 'Bearer not-the-team-token' });
      expectError(wrong, is, 401);
    });
  } else {
    skip('auth: no token / wrong token → 401', 'no TOKEN given; the app will send `Authorization: Bearer <token>`');
  }

  // 3. CORS (only matters for the web preview).
  await check('CORS preflight (web preview only)', async (is) => {
    const r = await call('OPTIONS', '/scans', undefined, {
      Origin: 'http://localhost:8081',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    });
    const allow = r.headers.get('access-control-allow-origin');
    if (!allow) is.warn('Access-Control-Allow-Origin', 'missing: fine for Expo Go on a phone, but the web preview (localhost:8081) cannot call this server');
    const headers = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    if (allow && !headers.includes('authorization') && headers !== '*') is.warn('Access-Control-Allow-Headers', 'should include Authorization and Content-Type');
  });

  // 4. Error format.
  await check('errors: unknown job → 404 { error }', async (is) => expectError(await call('GET', `/jobs/contract-check-missing-${Date.now()}`), is, 404));
  await check('errors: bad search body → 400 { error }', async (is) => expectError(await call('POST', '/search', {}), is, 400));
  await check('errors: invalid URL to build → 400 { error }', async (is) => expectError(await call('POST', '/scrapers/build', { url: 'not a url' }), is, 400));
  await check('errors: unknown product → 404 { error }', async (is) => expectError(await call('GET', `/products/contract-check-missing-${Date.now()}/listings`), is, 404));

  // 5. Scans (before anything is saved).
  await check('GET /scans', async (is) => {
    const r = await call('GET', '/scans');
    expectOk(r, is, [200]);
    checkScans(r.body, 'body', is);
    return r.ms;
  });

  if (opts.search === false) {
    for (const name of ['POST /search (job)', 'POST /scrapers/match', 'POST /scrapers/build (job)', 'POST /scrape a refused page (never scraped)', 'POST /scrape (job)', 'POST /scrape again (merge by pageId)', 'GET /scans after scrape', 'GET /products/:id/listings']) {
      skip(name, '--no-search');
    }
    return results;
  }

  // 6. Search.
  const searchProduct = opts.product ?? SAMPLE_PRODUCT;
  const searchReq: SearchRequest = { product: searchProduct, scanType: 'both', includeSimilar: true, region: 'MX' };
  let search: SearchResult | undefined;
  await check('POST /search (job)', async (is, setNote) => {
    const started = Date.now();
    const job = await runJob<SearchResult>('search', '/search', searchReq, is);
    if (job?.status === 'failed') is.error('job', `failed: ${job.error}`);
    if (job?.status === 'succeeded') {
      checkSearchResult(job.result, 'result', is, searchReq);
      search = job.result;
      const pages = search?.pages ?? [];
      setNote(`${pages.length} pages, ${search?.similarProducts?.length ?? 0} similar products, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    if (Date.now() - started > 95_000) is.warn('time', 'search took over 95 s; the reference implementation stops at 90 s');
  });

  const pages: SourcePage[] = Array.isArray(search?.pages) ? search.pages.filter((p) => p && typeof p.url === 'string') : [];
  if (pages.length === 0) {
    for (const name of ['POST /scrapers/match', 'POST /scrapers/build (job)', 'POST /scrape a refused page (never scraped)', 'POST /scrape (job)', 'POST /scrape again (merge by pageId)', 'GET /scans after scrape', 'GET /products/:id/listings']) {
      skip(name, 'needs pages from a successful search');
    }
    return results;
  }

  // 7. Scraper match.
  const status = new Map(pages.map((p) => [p.id, p.scraper?.status]));
  await check('POST /scrapers/match', async (is) => {
    const urls = pages.map((p) => p.url);
    const r = await call('POST', '/scrapers/match', { urls });
    expectOk(r, is, [200]);
    checkScraperMatches(r.body, 'body', is, urls);
    const matches = (r.body as { matches?: { status?: string }[] } | undefined)?.matches ?? [];
    matches.forEach((m, i) => pages[i] && m?.status && status.set(pages[i].id, m.status as SourcePage['scraper']['status']));
    return r.ms;
  });

  // 8. Build a scraper for a page that has none (or re-build the first one).
  const refused = (p: SourcePage) => p.access?.status === 'refused';
  const toBuild = pages.find((p) => status.get(p.id) === 'missing' && p.verification?.status !== 'rejected' && !refused(p)) ?? pages[0];
  await check('POST /scrapers/build (job)', async (is, setNote) => {
    const job = await runJob<BuildScraperResult>('build', '/scrapers/build', { url: toBuild.url, productId: searchProduct.id }, is);
    if (job?.status === 'failed') {
      // Legal: a blocked site is a failed job with a readable error (the app offers Retry).
      is.warn('job', `failed: ${job.error} (allowed, but check it is a real site block and not a bug)`);
    }
    if (job?.status === 'succeeded') {
      checkBuildResult(job.result, 'result', is, toBuild.url);
      status.set(toBuild.id, 'available');
      setNote(`${toBuild.domain} → ${job.result?.scraperId}`);
    }
  });

  // 9. A page the site refuses (access refused) is never scraped: it comes back in failures with its access code.
  const refusedPage = pages.find(refused);
  if (refusedPage) {
    await check('POST /scrape a refused page (never scraped)', async (is, setNote) => {
      const req: ScrapeRequest = { searchId: search!.searchId, productId: searchProduct.id, pageIds: [refusedPage.id] };
      const job = await runJob<ScrapeResult>('scrape', '/scrape', req, is);
      if (job?.status === 'failed') is.error('job', `failed: ${job.error} (put the refused page in result.failures instead)`);
      if (job?.status !== 'succeeded') return;
      checkScrapeResult(job.result, 'result', is, req);
      if (job.result?.listings?.some((l) => l?.pageId === refusedPage.id)) is.error('result.listings', `has a listing for ${refusedPage.domain}, which refuses collection (${refusedPage.access?.code})`);
      const failure = job.result?.failures?.find((f) => f?.pageId === refusedPage.id);
      if (failure && failure.code !== refusedPage.access?.code) is.warn('result.failures[].code', `should be the page's access code ${JSON.stringify(refusedPage.access?.code)}, got ${JSON.stringify(failure.code)}`);
      setNote(`${refusedPage.domain}: ${failure?.code ?? 'no code'}`);
    });
  } else {
    skip('POST /scrape a refused page (never scraped)', 'the search returned no page with access refused');
  }

  // 10. Scrape up to 3 scrapable pages, then one of them again.
  const scrapable = pages.filter((p) => status.get(p.id) === 'available' && p.verification?.status !== 'rejected' && !refused(p)).slice(0, 3);
  if (scrapable.length === 0) {
    for (const name of ['POST /scrape (job)', 'POST /scrape again (merge by pageId)', 'GET /scans after scrape', 'GET /products/:id/listings']) {
      skip(name, 'no page with an available scraper');
    }
    return results;
  }
  let scraped: ScrapeResult | undefined;
  const scrapeReq: ScrapeRequest = { searchId: search!.searchId, productId: searchProduct.id, pageIds: scrapable.map((p) => p.id) };
  await check('POST /scrape (job)', async (is, setNote) => {
    const job = await runJob<ScrapeResult>('scrape', '/scrape', scrapeReq, is);
    if (job?.status === 'failed') is.error('job', `failed: ${job.error} (a page that fails belongs in result.failures; fail the job only when nothing could run)`);
    if (job?.status === 'succeeded') {
      checkScrapeResult(job.result, 'result', is, scrapeReq);
      scraped = job.result;
      setNote(`${scraped?.listings?.length ?? 0} listings, ${scraped?.failures?.length ?? 0} failures, saved: ${scraped?.saved}`);
    }
  });

  const savedIds = new Set((scraped?.saved ? scraped.listings : []).map((l) => l.pageId));
  const again = scrapable.find((p) => savedIds.has(p.id));
  if (again) {
    await check('POST /scrape again (merge by pageId)', async (is) => {
      const req: ScrapeRequest = { ...scrapeReq, pageIds: [again.id] };
      const job = await runJob<ScrapeResult>('scrape', '/scrape', req, is);
      if (job?.status === 'failed') is.error('job', `failed: ${job.error}`);
      if (job?.status === 'succeeded') checkScrapeResult(job.result, 'result', is, req);
    });
  } else {
    skip('POST /scrape again (merge by pageId)', 'the first scrape saved nothing');
  }

  // 11. Saved data.
  await check('GET /scans after scrape', async (is) => {
    const r = await call('GET', '/scans');
    expectOk(r, is, [200]);
    checkScans(r.body, 'body', is);
    const scans = (r.body as { scans?: { product?: { id?: string }; listingCount?: number }[] } | undefined)?.scans ?? [];
    const ids = new Set([searchProduct.id, canonicalProductId(searchProduct)]);
    const mine = scans.find((s) => ids.has(s?.product?.id ?? ''));
    if (savedIds.size > 0 && !mine) is.error('body.scans', `must include ${canonicalProductId(searchProduct)} after a saved scrape`);
    if (mine && scans[0] !== mine) is.warn('body.scans', 'the product scraped just now should be first (newest first)');
    if (mine && typeof mine.listingCount === 'number' && mine.listingCount < savedIds.size) is.error('listingCount', `is ${mine.listingCount}, but ${savedIds.size} listings were just saved`);
    return r.ms;
  });

  await check('GET /products/:id/listings', async (is, setNote) => {
    const r = await call('GET', `/products/${encodeURIComponent(searchProduct.id)}/listings`);
    if (savedIds.size === 0 && r.status === 404) {
      checkErrorBody(r.body, 'body', is);
      setNote('404 (nothing saved)');
      return r.ms;
    }
    expectOk(r, is, [200]);
    checkProductListings(r.body, 'body', is, canonicalProductId(searchProduct));
    const listed = new Set(((r.body as { listings?: { pageId?: string }[] } | undefined)?.listings ?? []).map((l) => l?.pageId));
    for (const id of savedIds) if (!listed.has(id)) is.error('body.listings', `is missing the listing just saved for page ${id}`);
    setNote(`${listed.size} listings`);
    return r.ms;
  });

  return results;
}
