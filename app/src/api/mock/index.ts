import type { ProductApi } from '../client';
import type {
  AgentEvent,
  AgentProvider,
  AgentRun,
  BrandCatalog,
  BuildBatchRequest,
  BuildBatchResult,
  BuildDetail,
  BuildChanges,
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
  Job,
  JobProgress,
  Listing,
  PageAccess,
  ProductIdentity,
  ProductListings,
  ScanSummary,
  ScrapeFailure,
  ScraperMatch,
  ScrapeRequest,
  ScrapeResult,
  ScrapeSite,
  SearchRequest,
  SearchResult,
  SessionInsights,
  SourcePage,
} from '../types';
import { ApiError } from '../http';
import {
  changesFor,
  consoleStory,
  controlsFor,
  decisionLibrary,
  decisionsAt,
  insightsAt,
  postDecision,
  postGate,
  postMessage,
  postRetry,
  postStop,
  priceFieldOf,
  record,
  viewRun,
  type ConsoleRecord,
} from './build-console';
import { buildDetail, buildHistory } from './build-history';
import { agentRunAt, buildDuration, type BuildOutcome } from './build-timeline';
import {
  buildListing,
  buildPages,
  FAILING_BUILD_DOMAINS,
  FLAKY_BUILD_DOMAINS,
  listPrice,
  PRODUCTS,
  refusedAccess,
  retailerForDomain,
  scrapeFailureFor,
  similarFor,
  slugify,
} from './fixtures';

interface JobOutcome<T = unknown> {
  result?: T;
  error?: string;
  agentRun?: AgentRun;
}

interface MockJob {
  createdAt: number;
  /** Progress steps, each shown from `at` ms after creation. */
  steps: { at: number; progress: JobProgress }[];
  duration: number;
  run: () => JobOutcome;
  outcome?: JobOutcome;
  /** Live fields while the job runs (a build's agentRun, a scrape's sites), and the progress they imply. */
  live?: (elapsed: number) => { progress?: JobProgress; extra: Partial<Job<unknown>> };
}

/** The mock's builder: Devin unless EXPO_PUBLIC_MOCK_AGENT=claude_code (the backend's AGENT switch). */
export const MOCK_AGENT: AgentProvider = process.env.EXPO_PUBLIC_MOCK_AGENT === 'claude_code' ? 'claude_code' : 'devin';

/** Builder sessions the mock runs at once (the backend's MAX_PARALLEL_BUILDS). */
const PARALLEL_BUILDS = 4;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory backend that behaves like the real one, including slow jobs and failures. */
export class MockApi implements ProductApi {
  private jobs = new Map<string, MockJob>();
  private pages = new Map<string, SourcePage>();
  private searches = new Map<string, SearchResult>();
  private builtScrapers = new Map<string, string>();
  /** One build per site at a time, like the backend: domain → job id. */
  private activeBuilds = new Map<string, string>();
  /** Every build's record (its script and what people did in the console), for GET /builds. */
  private records = new Map<string, ConsoleRecord>();
  private listings = new Map<string, Listing[]>();
  /** Per product: pages whose latest scrape failed, by page id. */
  private failures = new Map<string, Map<string, ScrapeFailure>>();
  private scans = new Map<string, ScanSummary>();
  /** Similar products from live searches, so scraping their pages titles listings correctly. */
  private products = new Map<string, ProductIdentity>();
  private counter = 0;

  constructor(private readonly agent: AgentProvider = MOCK_AGENT) {
    this.seed();
  }

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }

  private createJob<T>(
    steps: { at: number; progress: JobProgress }[],
    duration: number,
    run: () => JobOutcome<T>,
    live?: MockJob['live'],
    jobId = this.nextId('job'),
  ): Job<T> {
    this.jobs.set(jobId, { createdAt: Date.now(), steps, duration, run, live });
    const first = live?.(0);
    return { jobId, status: 'queued', progress: steps[0]?.progress ?? first?.progress, agentRun: first?.extra.agentRun, sites: first?.extra.sites };
  }

  async getJob<T>(jobId: string): Promise<Job<T>> {
    await wait(120);
    const job = this.jobs.get(jobId);
    if (!job) return { jobId, status: 'failed', error: 'Job not found' };
    const elapsed = Date.now() - job.createdAt;
    const live = job.live?.(Math.min(elapsed, job.duration));
    if (elapsed < job.duration) {
      const current = [...job.steps].reverse().find((s) => elapsed >= s.at) ?? job.steps[0];
      return { jobId, status: 'running', progress: live?.progress ?? current?.progress, ...live?.extra } as Job<T>;
    }
    job.outcome ??= job.run();
    const extra = { ...live?.extra, ...(job.outcome.agentRun ? { agentRun: job.outcome.agentRun } : {}) };
    if (job.outcome.error) return { jobId, status: 'failed', error: job.outcome.error, progress: live?.progress, ...extra } as Job<T>;
    return { jobId, status: 'succeeded', result: job.outcome.result as T, progress: { step: 'done', message: 'Done', percent: 100 }, ...extra } as Job<T>;
  }

  async startSearch(req: SearchRequest): Promise<Job<SearchResult>> {
    await wait(200);
    const product = req.product;
    const pages = buildPages(product, req.scanType, req.includeSimilar).map((p) => this.withBuiltScraper(p));
    const result: SearchResult = {
      searchId: this.nextId('search'),
      product,
      pages,
      similarProducts: req.includeSimilar ? similarFor(product) : [],
    };
    return this.createJob<SearchResult>(
      [
        { at: 0, progress: { step: 'search', message: `Searching the web for ${product.productName}`, percent: 10 } },
        { at: 1800, progress: { step: 'verify', message: 'Checking each page is the same product', percent: 45 } },
        { at: 3600, progress: { step: 'rank', message: 'Ranking official pages and retailers', percent: 80 } },
      ],
      5000,
      () => {
        for (const p of result.pages) this.pages.set(p.id, p);
        this.searches.set(result.searchId, result);
        return { result };
      },
    );
  }

  /**
   * Accept a search done outside the mock (live Claude search) so the rest of the flow works on its pages.
   * Pages on known store domains get a scraper (`scr-<store>`); other sites (the brand's own) need a build.
   * Returns the result with those scraper statuses.
   */
  registerSearch(result: SearchResult, knownStores: (domain: string) => string | undefined): SearchResult {
    const pages = result.pages.map((p) => {
      const store = knownStores(p.domain);
      const access = p.access ?? refusedAccess(p.domain);
      const page: SourcePage = store && !access ? { ...p, scraper: { status: 'available', scraperId: `scr-${store}` } } : { ...p, access };
      return this.withBuiltScraper(page);
    });
    const registered = { ...result, pages };
    for (const p of pages) this.pages.set(p.id, p);
    for (const s of result.similarProducts) {
      this.products.set(s.id, { id: s.id, brand: s.brand, productName: s.productName, variant: s.variant, confidence: 1, source: 'claude' });
    }
    this.searches.set(registered.searchId, registered);
    return registered;
  }

  async matchScrapers(urls: string[]): Promise<ScraperMatch[]> {
    await wait(600);
    return urls.map((url) => {
      const domain = domainOf(url);
      if (refusedAccess(domain)) return { url, domain, status: 'missing' };
      const built = this.builtScrapers.get(domain);
      if (built) return { url, domain, status: 'available', scraperId: built };
      const building = this.activeBuilds.get(domain);
      if (building) return { url, domain, status: 'building', buildJobId: building };
      const known = [...this.pages.values()].find((p) => p.domain === domain && p.scraper.status === 'available');
      if (known) return { url, domain, status: 'available', scraperId: known.scraper.scraperId };
      const retailer = retailerForDomain(domain);
      return retailer?.scraper.status === 'available'
        ? { url, domain, status: 'available', scraperId: retailer.scraper.scraperId }
        : { url, domain, status: 'missing' };
    });
  }

  /**
   * A scripted build (build-timeline.ts): probe → build → gate → merge with the same AgentRun the backend sends.
   * La Comer fails the gate once and fixes it in the same session; 7-Eleven fails 3 times; refusing sites never
   * start a session. One build per site: asking again returns the running job.
   */
  async startBuildScraper(req: BuildScraperRequest): Promise<Job<BuildScraperResult>> {
    await wait(200);
    if (!/^https?:\/\/[^/]+\.[^/]+/.test(req.url)) throw new Error('That does not look like a product page URL');
    const domain = domainOf(req.url);
    const running = this.activeBuilds.get(domain);
    if (running) return this.getJob<BuildScraperResult>(running);
    const jobId = this.nextId('build');
    const page = (req.pageId && this.pages.get(req.pageId)) || [...this.pages.values()].find((p) => p.url === req.url);
    const access: PageAccess = page?.access ?? refusedAccess(domain) ?? { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' };
    const kind = page?.sourceType ?? 'third_party';
    const startedAt = Date.now();

    if (access.status === 'refused') {
      const run = refusedRun(jobId, req.url, domain, access, this.agent);
      this.records.set(jobId, record(() => run));
      return this.createJob<BuildScraperResult>(
        [{ at: 0, progress: { step: 'probe', message: `Checking robots.txt on ${domain}`, percent: 10 } }],
        900,
        () => ({ error: `${domain} refuses automated collection: ${access.reason}`, agentRun: run }),
        undefined,
        jobId,
      );
    }

    // A kit source name: [a-z][a-z0-9_]* (builds.py SOURCE_NAME).
    const source = `${slugify(domain.split('.')[0]).replace(/-/g, '_').replace(/^(\d)/, 's$1')}_mx`;
    const outcome: BuildOutcome = FAILING_BUILD_DOMAINS.has(domain) ? 'fail' : FLAKY_BUILD_DOMAINS.has(domain) ? 'fix' : 'pass';
    const at = (elapsed: number) =>
      agentRunAt({ buildId: jobId, url: req.url, domain, kind, source, outcome, provider: this.agent, startedAt, elapsed, access });
    this.records.set(jobId, record((now) => at(now - startedAt).run, { reader: 'vtex' }));
    this.activeBuilds.set(domain, jobId);
    return this.createJob<BuildScraperResult>(
      [],
      buildDuration(outcome),
      () => {
        this.activeBuilds.delete(domain);
        const { run } = at(Infinity);
        if (outcome === 'fail') return { error: run.note, agentRun: run };
        this.builtScrapers.set(domain, source);
        const built: SourcePage = page ? { ...page, scraper: { status: 'available', scraperId: source } } : userAddedPage(req.url, domain, source);
        for (const p of this.pages.values()) {
          if (p.domain === domain && p.access?.status !== 'refused') this.pages.set(p.id, { ...p, scraper: { status: 'available', scraperId: source } });
        }
        this.pages.set(built.id, built);
        return { result: { scraperId: source, domain, page: built, agentRun: run }, agentRun: run };
      },
      (elapsed) => {
        const { progress } = at(elapsed);
        return { progress, extra: { agentRun: this.view(jobId) ?? at(elapsed).run } };
      },
      jobId,
    );
  }

  /** POST /scrapers/build-batch: one build per site without a scraper; the rest are skipped with the reason. */
  async startBuildBatch(req: BuildBatchRequest): Promise<BuildBatchResult> {
    await wait(200);
    const result: BuildBatchResult = { builds: [], skipped: [], parallel: PARALLEL_BUILDS };
    const started = new Map<string, string>();
    for (const pageId of req.pageIds) {
      const page = this.pages.get(pageId);
      if (!page) {
        result.skipped.push({ pageId, domain: null, reason: 'unknown page', code: 'unknown_page' });
      } else if (page.access?.status === 'refused') {
        result.skipped.push({ pageId, domain: page.domain, reason: page.access.reason, code: page.access.code });
      } else if (page.scraper.status === 'available' || this.builtScrapers.has(page.domain)) {
        result.skipped.push({ pageId, domain: page.domain, reason: 'already has a scraper', code: 'has_scraper' });
      } else {
        const duplicate = started.has(page.domain);
        const jobId = started.get(page.domain) ?? (await this.startBuildScraper({ url: page.url, productId: req.productId, pageId })).jobId;
        started.set(page.domain, jobId);
        result.builds.push({ pageId, domain: page.domain, jobId, duplicate });
      }
    }
    return result;
  }

  /** Each page shows queued → fetching → done/failed/refused/blocked, then taxonomy and save. */
  async startScrape(req: ScrapeRequest): Promise<Job<ScrapeResult>> {
    await wait(200);
    const search = this.searches.get(req.searchId);
    const product = search?.product ?? PRODUCTS[req.productId] ?? PRODUCTS['doritos-incognita'];
    const pages = req.pageIds.map((id) => this.pages.get(id));
    const outcomes = pages.map((page, i) => this.scrapeOne(req.pageIds[i], page, product));
    // Like the backend: sites in parallel (staggered a little), each site's pages one after another.
    const PAGE_MS = 650;
    const domains = [...new Set(pages.map((p, i) => p?.domain ?? req.pageIds[i]))];
    const starts = pages.map((p, i) => {
      const domain = p?.domain ?? req.pageIds[i];
      const before = pages.slice(0, i).filter((q, j) => (q?.domain ?? req.pageIds[j]) === domain).length;
      return 300 + 180 * domains.indexOf(domain) + PAGE_MS * before;
    });
    const sitesAt = (elapsed: number): ScrapeSite[] =>
      req.pageIds.map((id, i) => {
        const page = pages[i];
        const base = { pageId: id, domain: page?.domain ?? '', retailerName: page?.retailerName ?? id, rows: 0 };
        if (elapsed < starts[i]) return { ...base, state: 'queued', message: 'Waiting' };
        if (elapsed < starts[i] + PAGE_MS) return { ...base, state: 'fetching', message: `Reading ${base.domain}` };
        return { ...base, ...outcomes[i].site };
      });
    const readDone = Math.max(300, ...starts) + PAGE_MS;
    return this.createJob<ScrapeResult>(
      [],
      readDone + 1600,
      () => {
        const now = new Date();
        const listings: Listing[] = [];
        const failures: ScrapeFailure[] = [];
        const catalogs: BrandCatalog[] = [];
        for (const [i, o] of outcomes.entries()) {
          if (o.failure) failures.push(o.failure);
          const page = pages[i];
          if (!page || o.failure) continue;
          const similarId = page.similarProductId;
          const pageProduct = (similarId && (this.products.get(similarId) ?? PRODUCTS[similarId])) || product;
          listings.push(buildListing(page, pageProduct, now));
          if (o.catalog) catalogs.push(catalogOf(page, product, now));
        }
        this.saveListings(product, listings, now);
        this.saveFailures(product.id, listings, failures);
        return {
          result: { runId: this.nextId('run'), saved: listings.length > 0, savedAt: now.toISOString(), listings, failures, catalogs, sites: sitesAt(Infinity) },
        };
      },
      (elapsed) => {
        const sites = sitesAt(elapsed);
        const finished = sites.filter((s) => s.state !== 'queued' && s.state !== 'fetching').length;
        const progress: JobProgress =
          elapsed < readDone
            ? { step: 'scrape', message: `${finished} of ${sites.length} pages read`, percent: 10 + Math.round((50 * finished) / Math.max(1, sites.length)) }
            : elapsed < readDone + 800
              ? { step: 'taxonomy', message: 'Mapping categories to Google Product Taxonomy', percent: 70 }
              : { step: 'save', message: 'Saving listings', percent: 90 };
        return { progress, extra: { sites } };
      },
    );
  }

  /** What scraping one page gives: its final site line, and a failure or (for the brand's own page) a catalog. */
  private scrapeOne(id: string, page: SourcePage | undefined, product: ProductIdentity): { site: Pick<ScrapeSite, 'state' | 'message' | 'rows'>; failure?: ScrapeFailure; catalog?: boolean } {
    if (!page) return { site: { state: 'failed', message: 'Unknown page', rows: 0 }, failure: { pageId: id, url: '', error: 'Unknown page' } };
    const fail = (state: ScrapeSite['state'], message: string, failure: Omit<ScrapeFailure, 'pageId' | 'url' | 'retailerName'>) => ({
      site: { state, message, rows: 0 },
      failure: { pageId: id, url: page.url, retailerName: page.retailerName, ...failure },
    });
    if (page.access?.status === 'refused') return fail('refused', page.access.reason, { error: `Not collected: ${page.access.reason}`, code: page.access.code });
    if (page.scraper.status !== 'available') return fail('failed', 'No scraper for this site yet', { error: 'No scraper for this site yet', code: 'no_scraper' });
    const scrapeFail = scrapeFailureFor(page);
    if (scrapeFail) return fail(scrapeFail.code === 'blocked' ? 'blocked' : 'failed', scrapeFail.error, { error: scrapeFail.error, code: scrapeFail.code });
    if (page.sourceType === 'first_party' && page.matchType === 'exact') {
      const count = catalogProducts(product).length;
      return { site: { state: 'done', message: `Catalog of ${count} products; matched ${product.productName}`, rows: count }, catalog: true };
    }
    return { site: { state: 'done', message: `Read ${page.title}`, rows: 1 } };
  }

  async listScans(): Promise<ScanSummary[]> {
    await wait(400);
    return [...this.scans.values()].sort((a, b) => (b.lastScrapedAt ?? '').localeCompare(a.lastScrapedAt ?? ''));
  }

  async getProductListings(productId: string): Promise<ProductListings> {
    await wait(500);
    const summary = this.scans.get(productId);
    const product = summary?.product ?? PRODUCTS[productId];
    if (!product) throw new Error(`Product ${productId} not found`);
    const failures = [...(this.failures.get(productId)?.values() ?? [])];
    return { product, listings: this.listings.get(productId) ?? [], ...(failures.length ? { failures } : {}) };
  }

  async getHealth() {
    await wait(100);
    return { ok: true, version: 'mock', agent: this.agent, sources: [...new Set(this.builtScrapers.values())] };
  }

  async listBuilds(query: BuildQuery = {}): Promise<BuildHistory> {
    await wait(300);
    const now = Date.now();
    const runs = [...this.records.values()].map((r) => viewRun(r, now));
    return buildHistory(runs, query, PARALLEL_BUILDS);
  }

  async getBuild(buildId: string): Promise<BuildDetail> {
    await wait(250);
    const rec = this.recordOf(buildId);
    const now = Date.now();
    const run = viewRun(rec, now);
    const decisions = decisionsAt(rec, now);
    return { ...buildDetail(run), controls: controlsFor(run, decisions), decisions, reused: rec.reused ?? [] };
  }

  private view(buildId: string) {
    const rec = this.records.get(buildId);
    return rec ? viewRun(rec, Date.now()) : undefined;
  }

  private recordOf(buildId: string): ConsoleRecord {
    const rec = this.records.get(buildId);
    if (!rec) throw new ApiError(`Build ${buildId} not found`, 404, 'not_found');
    return rec;
  }

  async messageBuild(buildId: string, req: BuildMessageRequest): Promise<AgentEvent> {
    await wait(200);
    return postMessage(this.recordOf(buildId), req, Date.now());
  }

  async stopBuild(buildId: string, by?: string): Promise<AgentRun> {
    await wait(200);
    return postStop(this.recordOf(buildId), by, Date.now());
  }

  async retryBuild(buildId: string, req: BuildRetryRequest): Promise<BuildRetryResult> {
    await wait(300);
    const newId = this.nextId('build');
    const { record: next, sameSession } = postRetry(this.recordOf(buildId), req, newId, Date.now());
    this.records.set(newId, next);
    return { buildId: newId, jobId: newId, sameSession };
  }

  async gateBuild(buildId: string, by?: string): Promise<AgentEvent> {
    await wait(200);
    return postGate(this.recordOf(buildId), by, Date.now());
  }

  async getBuildChanges(buildId: string): Promise<BuildChanges> {
    await wait(300);
    const rec = this.recordOf(buildId);
    const now = Date.now();
    const changes = changesFor(viewRun(rec, now), priceFieldOf(decisionsAt(rec, now)));
    if (!changes) throw new ApiError("The builder hasn't changed anything yet.", 409, 'not_available');
    return changes;
  }

  async getBuildInsights(buildId: string): Promise<SessionInsights> {
    await wait(250);
    return insightsAt(this.recordOf(buildId), Date.now());
  }

  // `by` is recorded by the real backend; the mock has nowhere to show it.
  async generateBuildInsights(buildId: string, _by?: string): Promise<SessionInsights> {
    await wait(250);
    const rec = this.recordOf(buildId);
    const now = Date.now();
    const run = viewRun(rec, now);
    const control = controlsFor(run, decisionsAt(rec, now)).insights;
    if (!control.ok) throw new ApiError(control.why ?? 'Not possible now.', 409, 'not_available');
    rec.insightsAt = now;
    rec.insightsReady = false;
    return insightsAt(rec, now);
  }

  async decideBuild(buildId: string, req: DecisionRequest): Promise<DecisionResult> {
    await wait(250);
    return postDecision(this.recordOf(buildId), buildId, req, Date.now());
  }

  async listDecisions(query: { reader?: string } = {}): Promise<DecisionLibrary> {
    await wait(300);
    const now = Date.now();
    const all = [...this.records.values()].map((rec) => ({ rec, run: viewRun(rec, now) }));
    return decisionLibrary(all, now, query.reader);
  }

  private withBuiltScraper(page: SourcePage): SourcePage {
    const built = this.builtScrapers.get(page.domain);
    return built && page.access?.status !== 'refused' ? { ...page, scraper: { status: 'available', scraperId: built } } : page;
  }

  /** Keep each page's latest failure until a later scrape of it succeeds. */
  private saveFailures(productId: string, listings: Listing[], failures: ScrapeFailure[]) {
    const byPage = this.failures.get(productId) ?? new Map<string, ScrapeFailure>();
    for (const l of listings) byPage.delete(l.pageId);
    for (const f of failures) if (f.url) byPage.set(f.pageId, f);
    this.failures.set(productId, byPage);
  }

  private saveListings(product: ProductIdentity, listings: Listing[], now: Date) {
    if (listings.length === 0) return;
    const existing = this.listings.get(product.id) ?? [];
    const byPage = new Map(existing.map((l) => [l.pageId, l]));
    for (const l of listings) byPage.set(l.pageId, l);
    const merged = [...byPage.values()];
    this.listings.set(product.id, merged);
    this.scans.set(product.id, { product, lastScrapedAt: now.toISOString(), listingCount: merged.length });
  }

  private seed() {
    const seedOne = (productId: string, hoursAgo: number) => {
      const product = PRODUCTS[productId];
      const when = new Date(Date.now() - hoursAgo * 3600_000);
      const scrapable = buildPages(product, 'both', false).filter((p) => p.scraper.status === 'available');
      const listings = scrapable.filter((p) => !scrapeFailureFor(p)).map((p) => buildListing(p, product, when));
      const failures = scrapable.flatMap((p) => {
        const fail = scrapeFailureFor(p);
        return fail ? [{ pageId: p.id, url: p.url, ...fail }] : [];
      });
      this.saveListings(product, listings, when);
      this.saveFailures(product.id, listings, failures);
    };
    seedOne('takis-fuego', 3);
    seedOne('doritos-nacho', 26);
    // The console's story: builds to watch and steer.
    const refusal: PageAccess = refusedAccess('amazon.com.mx') ?? { status: 'refused', code: 'ai_opt_out', reason: 'robots.txt opts out of AI agents' };
    for (const { id, rec } of consoleStory(Date.now(), refusal)) this.records.set(id, rec);
  }
}

/** Made-up extra lines a brand's catalog lists in the mock, so the catalog is longer than one screen. */
const CATALOG_EXTRAS = ['Original 45 g', 'Queso 62 g', 'Chile y Limón 56 g', 'Familiar 230 g', 'Mini 25 g', 'Mix 12 piezas', 'Picante 62 g', 'Edición limitada 150 g'];

/** The brand's products in the mock: the scanned one first, then the brand's other fixtures, then made-up lines. */
export function catalogProducts(product: ProductIdentity): ProductIdentity[] {
  const same = Object.values(PRODUCTS).filter((p) => p.brand === product.brand && p.id !== product.id);
  const extras = CATALOG_EXTRAS.map((line, i): ProductIdentity => ({
    id: `${slugify(product.brand)}-catalog-${i}`,
    brand: product.brand,
    productName: `${product.brand} ${line}`,
    confidence: 1,
    source: 'mock',
  }));
  return [product, ...same, ...extras];
}

/** A brand site read as its whole catalog: one row per product, the scanned one included. */
function catalogOf(page: SourcePage, product: ProductIdentity, now: Date): BrandCatalog {
  const listings = catalogProducts(product).map((p, i) => {
    const row = buildListing({ ...page, id: `${page.id}--${p.id}` }, p, now);
    const url = p.id === product.id ? page.url : `https://${page.domain}/productos/${slugify(p.productName)}`;
    return { ...row, id: `${row.id}-${i}`, pageId: page.id, url, price: { amount: listPrice(p.id), currency: 'MXN' } };
  });
  return { pageId: page.id, domain: page.domain, retailerName: page.retailerName, source: page.scraper.scraperId ?? '', count: listings.length, scrapedAt: now.toISOString(), listings };
}

function domainOf(url: string) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return (match?.[1] ?? url).toLowerCase().replace(/^www\./, '');
}

function userAddedPage(url: string, domain: string, scraperId: string): SourcePage {
  const retailer = retailerForDomain(domain);
  return {
    id: `user--${slugify(url)}`,
    url,
    domain,
    retailerName: retailer?.retailerName ?? domain,
    sourceType: 'third_party',
    title: url,
    matchType: 'exact',
    verification: { status: 'user_added', confidence: 1, reason: 'Added by you' },
    scraper: { status: 'available', scraperId },
  };
}

/** The build record for a site that refuses collection: no builder ran. */
function refusedRun(buildId: string, url: string, domain: string, access: PageAccess, provider: AgentProvider): AgentRun {
  const now = new Date().toISOString();
  return {
    buildId,
    provider,
    url,
    domain,
    kind: 'third_party',
    state: 'refused',
    stage: 'probing',
    note: access.reason,
    access,
    attempt: 0,
    maxAttempts: 0,
    attempts: [],
    events: [{ at: now, kind: 'system', stage: 'probing', message: `Refused: ${access.reason}`, attempt: 0 }],
    startedAt: now,
    endedAt: now,
  };
}
