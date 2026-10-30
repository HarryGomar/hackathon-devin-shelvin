/**
 * A tiny in-memory server that follows docs/backend-spec.md, for `npm run check -- --mock` and the tests.
 * It is a reference for the shapes only: no web search, no scraping, canned data. `faults` breaks it on purpose so
 * tests can prove the checker notices.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { STEP_KEYS, type JobKind } from './extra-types.ts';
import type { Job, JobProgress, Listing, PageAccess, ProductIdentity, ScanSummary, ScrapeFailure, SearchRequest, SearchResult, SourcePage } from './types.ts';
import { domainOf } from './validate.ts';

export type Fault = 'nested-error' | 'no-auth' | 'old-step-keys' | 'duplicate-listings' | 'scrape-refused';

export interface StubOptions {
  token?: string;
  /** How long each job step lasts. */
  stepMs?: number;
  faults?: Fault[];
}

export interface RunningStub {
  baseUrl: string;
  close(): Promise<void>;
}

interface StubJob {
  kind: JobKind;
  createdAt: number;
  steps: JobProgress[];
  run: () => { result?: unknown; error?: string };
  outcome?: { result?: unknown; error?: string };
}

const MAX_BODY = 8 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function slugify(...parts: (string | undefined)[]) {
  return (
    parts
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'product'
  );
}

const KNOWN_STORES: Record<string, string> = {
  'super.walmart.com.mx': 'Walmart Súper',
  'soriana.com': 'Soriana',
  'chedraui.com.mx': 'Chedraui',
  'heb.com.mx': 'HEB México',
  'mercadolibre.com.mx': 'Mercado Libre',
  'amazon.com.mx': 'Amazon México',
};

const ALLOWED: PageAccess = { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' };

/** Sites whose robots.txt refuses us: never built or scraped (docs/backend-spec.md §8 "Refusals"). */
const REFUSED: Record<string, PageAccess> = {
  'amazon.com.mx': {
    status: 'refused',
    code: 'ai_opt_out',
    label: 'Blocks AI agents',
    reason: 'robots.txt blocks AI agents (ClaudeBot, GPTBot)',
    alternative: "Amazon's Creators API (needs an Amazon Associates México account)",
  },
};

/** Sites that answer 403 when scraped: the kit stops, and the page is a `blocked` failure. */
const FORBIDDEN_ON_SCRAPE = new Set(['heb.com.mx']);

function identityFor(code: string): ProductIdentity {
  return {
    id: 'doritos-nacho-61-g',
    brand: 'Doritos',
    productName: 'Doritos Nacho',
    variant: 'Nacho',
    size: '61 g',
    barcode: code,
    manufacturer: 'Sabritas (PepsiCo México)',
    categoryGuess: 'Botanas > Totopos',
    imageUrl: 'https://images.openfoodfacts.org/images/products/750/101/112/3588/front_es.3.400.jpg',
    imageSource: 'openfoodfacts',
    confidence: 0.93,
    source: 'claude',
  };
}

function page(product: ProductIdentity, url: string, extra: Partial<SourcePage> = {}): SourcePage {
  const domain = domainOf(url);
  return {
    id: `web-${slugify(domain)}-${slugify(url).slice(-8)}`,
    url,
    domain,
    retailerName: KNOWN_STORES[domain] ?? `${product.brand} (official site)`,
    sourceType: KNOWN_STORES[domain] ? 'third_party' : 'first_party',
    title: `${product.productName} ${product.size ?? ''}`.trim(),
    matchType: 'exact',
    verification: { status: 'verified', confidence: 0.9, reason: 'Same brand, flavor and size' },
    scraper: KNOWN_STORES[domain] && !REFUSED[domain] ? { status: 'available', scraperId: `scr-${slugify(domain)}` } : { status: 'missing' },
    access: REFUSED[domain] ?? ALLOWED,
    ...extra,
  };
}

export async function startStub(opts: StubOptions = {}): Promise<RunningStub> {
  const stepMs = opts.stepMs ?? 700;
  const faults = new Set(opts.faults ?? []);
  const jobs = new Map<string, StubJob>();
  const pages = new Map<string, SourcePage>();
  const searches = new Map<string, SearchResult>();
  const scrapers = new Map<string, string>();
  const listings = new Map<string, Listing[]>();
  /** Per product: each page's latest failure, until it gets a listing. */
  const failed = new Map<string, Map<string, ScrapeFailure>>();
  const scans = new Map<string, ScanSummary>();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter += 1)}`;

  const createJob = (kind: JobKind, messages: string[], run: StubJob['run']): Job<unknown> => {
    const keys = faults.has('old-step-keys') ? ['searching_web', 'verifying_pages', 'matching_scrapers'] : STEP_KEYS[kind];
    const steps = keys.map((step, i) => ({ step, message: messages[i] ?? step, percent: Math.round(((i + 1) / (keys.length + 1)) * 100) }));
    const jobId = nextId(kind);
    jobs.set(jobId, { kind, createdAt: Date.now(), steps, run });
    return { jobId, status: 'queued', progress: steps[0] };
  };

  const jobView = (jobId: string): Job<unknown> => {
    const job = jobs.get(jobId);
    if (!job) throw new HttpError(404, 'not_found', `Job ${jobId} not found`);
    const index = Math.floor((Date.now() - job.createdAt) / stepMs);
    if (index < job.steps.length) return { jobId, status: 'running', progress: job.steps[index] };
    job.outcome ??= job.run();
    if (job.outcome.error) return { jobId, status: 'failed', error: job.outcome.error };
    return { jobId, status: 'succeeded', result: job.outcome.result, progress: { step: 'done', message: 'Done', percent: 100 } };
  };

  const withScraper = (p: SourcePage): SourcePage => {
    const built = scrapers.get(p.domain);
    return built ? { ...p, scraper: { status: 'available', scraperId: built } } : p;
  };

  const routes = async (method: string, path: string, body: unknown): Promise<[number, unknown]> => {
    if (method === 'GET' && path === '/health') return [200, { ok: true, version: 'contract-check-stub' }];

    if (method === 'POST' && path === '/search') {
      const req = body as Partial<SearchRequest>;
      if (!req.product || typeof req.product.id !== 'string' || !req.scanType) throw new HttpError(400, 'invalid_request', 'product and scanType are required');
      const product = req.product;
      const all = [
        page(product, 'https://www.doritos.com.mx/productos/doritos-nacho'),
        page(product, 'https://super.walmart.com.mx/ip/botana-doritos-nacho-61-g/00750101112358'),
        page(product, 'https://www.heb.com.mx/doritos-nacho-61-g-7501011123588/p'),
        page(product, 'https://www.soriana.com/doritos-nacho-61-g/7501011123588.html'),
        page(product, 'https://www.amazon.com.mx/dp/B0STUB0001', { verification: { status: 'uncertain', confidence: 0.6, reason: 'Listing shows a 6-pack' } }),
        page(product, 'https://www.chedraui.com.mx/doritos-nacho-61g-3456789/p', { verification: { status: 'uncertain', confidence: 0.6, reason: 'Size not shown' } }),
        page(product, 'https://www.mercadolibre.com.mx/doritos-nacho-pack-20/up/MLMU1', { verification: { status: 'rejected', confidence: 0.2, reason: '20-bag multipack' } }),
      ];
      const similarProducts = req.includeSimilar
        ? [{ id: 'similar-takis-fuego', brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', relation: 'competitor' as const, reason: 'Competing spicy corn snack' }]
        : [];
      const similarPages = req.includeSimilar
        ? [page(product, 'https://www.soriana.com/takis-fuego-70-g/7500810003671.html', { matchType: 'similar', similarProductId: 'similar-takis-fuego', title: 'Takis Fuego 70 g' })]
        : [];
      const chosen = [...all, ...similarPages].filter((p) => req.scanType === 'both' || p.sourceType === req.scanType).map(withScraper);
      const result: SearchResult = { searchId: nextId('srch'), product, pages: chosen, similarProducts };
      return [
        202,
        createJob('search', [`Searching Mexican stores for ${product.productName}`, 'Checking each page is the same product', 'Ranking official pages and retailers'], () => {
          for (const p of chosen) pages.set(p.id, p);
          searches.set(result.searchId, result);
          return { result };
        }),
      ];
    }

    if (method === 'POST' && path === '/scrapers/match') {
      const urls = (body as { urls?: unknown }).urls;
      if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string')) throw new HttpError(400, 'invalid_request', 'urls must be a list of strings');
      return [
        200,
        {
          matches: (urls as string[]).map((url) => {
            const domain = domainOf(url);
            const id = REFUSED[domain] ? undefined : (scrapers.get(domain) ?? (KNOWN_STORES[domain] ? `scr-${slugify(domain)}` : undefined));
            return id ? { url, domain, status: 'available', scraperId: id } : { url, domain, status: 'missing' };
          }),
        },
      ];
    }

    if (method === 'POST' && path === '/scrapers/build') {
      const { url } = body as { url?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(url)) throw new HttpError(400, 'invalid_url', 'That does not look like a product page URL');
      const domain = domainOf(url);
      const refused = REFUSED[domain];
      if (refused) {
        return [202, createJob('build', [`Checking robots.txt on ${domain}`], () => ({ error: `${domain} refuses automated collection: ${refused.reason}` }))];
      }
      return [
        202,
        createJob('build', [`Checking robots.txt on ${domain}`, 'Building the scraper', 'Gate: checking the scraper on the page', 'Making the scraper live'], () => {
          const scraperId = `scr-${slugify(domain)}`;
          scrapers.set(domain, scraperId);
          for (const p of pages.values()) if (p.domain === domain) pages.set(p.id, withScraper(p));
          const existing = [...pages.values()].find((p) => p.url === url);
          const built: SourcePage = existing ?? {
            ...page(identityFor(''), url),
            id: `user-${slugify(url).slice(-12)}`,
            title: url,
            sourceType: 'third_party',
            verification: { status: 'user_added', confidence: 1, reason: 'Added by you' },
            scraper: { status: 'available', scraperId },
          };
          pages.set(built.id, built);
          return { result: { scraperId, domain, page: built } };
        }),
      ];
    }

    if (method === 'POST' && path === '/scrape') {
      const req = body as { searchId?: unknown; productId?: unknown; pageIds?: unknown };
      if (typeof req.productId !== 'string' || !Array.isArray(req.pageIds)) throw new HttpError(400, 'invalid_request', 'productId and pageIds are required');
      const pageIds = req.pageIds as string[];
      const productId = req.productId;
      const product = (typeof req.searchId === 'string' && searches.get(req.searchId)?.product) || scans.get(productId)?.product;
      if (!product) throw new HttpError(404, 'not_found', `Search ${String(req.searchId)} not found`);
      return [
        202,
        createJob('scrape', [`Scraping ${pageIds.length} page(s)`, 'Mapping categories to the standard taxonomy', 'Saving listings'], () => {
          const now = new Date().toISOString();
          const done: Listing[] = [];
          const failures: ScrapeFailure[] = [];
          for (const id of pageIds) {
            const p = pages.get(id);
            if (!p) failures.push({ pageId: id, url: '', error: 'Unknown page' });
            else if (p.access?.status === 'refused' && !faults.has('scrape-refused')) failures.push({ pageId: id, url: p.url, error: `Not collected: ${p.access.reason}`, code: p.access.code, retailerName: p.retailerName });
            else if (p.scraper.status !== 'available' && !faults.has('scrape-refused')) failures.push({ pageId: id, url: p.url, error: 'No scraper for this site yet', code: 'no_scraper', retailerName: p.retailerName });
            else if (FORBIDDEN_ON_SCRAPE.has(p.domain)) failures.push({ pageId: id, url: p.url, error: `${p.domain} answered 403 Forbidden; the run stopped`, code: 'blocked', retailerName: p.retailerName });
            else {
              done.push({
                id: nextId('lst'),
                pageId: p.id,
                url: p.url,
                domain: p.domain,
                retailerName: p.retailerName,
                title: p.title,
                price: { amount: 18.5 + done.length, currency: 'MXN' },
                categoryPath: ['Despensa', 'Botanas', 'Papas y totopos'],
                standardTaxonomy: { system: 'Google Product Taxonomy', path: ['Food, Beverages & Tobacco', 'Food Items', 'Snack Foods', 'Chips'], code: '2392' },
                fields: { net_weight: '61 g', availability: 'in_stock', sku: p.id },
                scrapedAt: now,
              });
            }
          }
          const byPage = failed.get(productId) ?? new Map<string, ScrapeFailure>();
          for (const l of done) byPage.delete(l.pageId);
          for (const f of failures) if (f.url) byPage.set(f.pageId, f);
          failed.set(productId, byPage);
          if (done.length > 0) {
            const previous = listings.get(productId) ?? [];
            const merged = faults.has('duplicate-listings') ? [...previous, ...done] : [...new Map([...previous, ...done].map((l) => [l.pageId, l])).values()];
            listings.set(productId, merged);
            scans.set(productId, { product, lastScrapedAt: now, listingCount: merged.length });
          }
          return { result: { runId: nextId('run'), saved: done.length > 0, savedAt: now, listings: done, failures } };
        }),
      ];
    }

    const job = /^\/jobs\/([^/]+)$/.exec(path);
    if (method === 'GET' && job) return [200, jobView(decodeURIComponent(job[1]))];

    if (method === 'GET' && path === '/scans') {
      return [200, { scans: [...scans.values()].sort((a, b) => (b.lastScrapedAt ?? '').localeCompare(a.lastScrapedAt ?? '')) }];
    }

    const product = /^\/products\/([^/]+)\/listings$/.exec(path);
    if (method === 'GET' && product) {
      const id = decodeURIComponent(product[1]);
      const summary = scans.get(id);
      if (!summary) throw new HttpError(404, 'not_found', `Product ${id} not found`);
      const failures = [...(failed.get(id)?.values() ?? [])];
      return [200, { product: summary.product, listings: listings.get(id) ?? [], ...(failures.length ? { failures } : {}) }];
    }

    throw new HttpError(404, 'not_found', `No route for ${method} ${path}`);
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    try {
      if (opts.token && path !== '/health' && !faults.has('no-auth') && req.headers.authorization !== `Bearer ${opts.token}`) {
        throw new HttpError(401, 'unauthorized', 'This server needs the team token (EXPO_PUBLIC_API_TOKEN)');
      }
      let body: unknown;
      if (method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'The request is too large');
          chunks.push(chunk as Buffer);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          throw new HttpError(400, 'invalid_request', 'The body is not JSON');
        }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_request', 'The body must be a JSON object');
      }
      const [status, out] = await routes(method, path, body);
      send(res, status, out);
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal', 'Something went wrong on the server');
      send(res, err.status, faults.has('nested-error') ? { error: { code: err.code, message: err.message } } : { error: err.message, code: err.code });
    }
  };

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
