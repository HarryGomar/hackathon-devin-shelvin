/**
 * Shape checks for every contract type. Pure (no I/O). Each check appends issues with a JSON path; extra fields are
 * always allowed (the contract is additive), missing or mistyped ones are errors, odd-but-legal values are warnings.
 */
import { STEP_KEYS, type JobKind } from './extra-types.ts';
import type { ScrapeRequest, SearchRequest } from './types.ts';

export interface Issue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

export class Issues {
  readonly list: Issue[] = [];

  error(path: string, message: string) {
    this.list.push({ severity: 'error', path, message });
  }

  warn(path: string, message: string) {
    this.list.push({ severity: 'warning', path, message });
  }

  get hasErrors() {
    return this.list.some((i) => i.severity === 'error');
  }
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;
const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'missing' : JSON.stringify(v)?.slice(0, 80));

function obj(v: unknown, path: string, is: Issues): Obj | undefined {
  if (isObj(v)) return v;
  is.error(path, `must be an object, got ${show(v)}`);
  return undefined;
}

function str(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean; nonEmpty?: boolean } = {}): string | undefined {
  const v = o[key];
  if (absent(v)) {
    if (!opts.optional) is.error(`${path}.${key}`, 'is required (string)');
    return undefined;
  }
  if (typeof v !== 'string') {
    is.error(`${path}.${key}`, `must be a string, got ${show(v)}`);
    return undefined;
  }
  if (opts.nonEmpty !== false && v.trim() === '') is.error(`${path}.${key}`, 'must not be empty');
  return v;
}

function num(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean; min?: number; max?: number } = {}): number | undefined {
  const v = o[key];
  if (absent(v)) {
    if (!opts.optional) is.error(`${path}.${key}`, 'is required (number)');
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    is.error(`${path}.${key}`, `must be a number, got ${show(v)}`);
    return undefined;
  }
  if ((opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) {
    is.error(`${path}.${key}`, `must be between ${opts.min} and ${opts.max}, got ${v}`);
  }
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, values: readonly T[], path: string, is: Issues, opts: { optional?: boolean } = {}): T | undefined {
  const v = o[key];
  if (absent(v)) {
    if (!opts.optional) is.error(`${path}.${key}`, `is required (one of ${values.join(' | ')})`);
    return undefined;
  }
  if (!values.includes(v as T)) {
    is.error(`${path}.${key}`, `must be one of ${values.join(' | ')}, got ${show(v)}`);
    return undefined;
  }
  return v as T;
}

function arr(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean } = {}): unknown[] | undefined {
  const v = o[key];
  if (absent(v)) {
    if (!opts.optional) is.error(`${path}.${key}`, 'is required (array)');
    return undefined;
  }
  if (!Array.isArray(v)) {
    is.error(`${path}.${key}`, `must be an array, got ${show(v)}`);
    return undefined;
  }
  return v;
}

function strings(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean } = {}) {
  const list = arr(o, key, path, is, opts);
  list?.forEach((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') is.error(`${path}.${key}[${i}]`, `must be a non-empty string, got ${show(v)}`);
  });
  return list as string[] | undefined;
}

function isoDate(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean } = {}) {
  const v = str(o, key, path, is, opts);
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    is.error(`${path}.${key}`, `must be an ISO 8601 timestamp like 2026-10-28T18:30:00.000Z, got ${show(v)}`);
  }
}

function httpUrl(o: Obj, key: string, path: string, is: Issues, opts: { optional?: boolean } = {}) {
  const v = str(o, key, path, is, opts);
  if (v !== undefined && !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(v)) is.error(`${path}.${key}`, `must be an http(s) URL, got ${show(v)}`);
  if (v !== undefined && /^http:\/\//i.test(v) && key.toLowerCase().includes('image')) {
    is.warn(`${path}.${key}`, 'is plain http; iOS may refuse to load it (use https)');
  }
  return v;
}

/** "https://www.Example.com/x" → "example.com" (same rule as the app). */
export function domainOf(url: string): string {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return (match?.[1] ?? '').toLowerCase().replace(/^www\./, '');
}

// ---------- Bodies ----------

export function checkErrorBody(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  if (isObj(o.error)) {
    is.error(`${path}.error`, 'must be a string. The app shows `error` as is, so a nested { code, message } object reads "[object Object]"; put the code in a top-level `code` field');
    return;
  }
  str(o, 'error', path, is);
  str(o, 'code', path, is, { optional: true });
}

export function checkHealth(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  if (o.ok !== true) is.error(`${path}.ok`, `must be true, got ${show(o.ok)}`);
  str(o, 'version', path, is, { optional: true });
}

const IDENTITY_SOURCES = ['mock', 'claude', 'openfoodfacts', 'user_edited'] as const;
const IMAGE_SOURCES = ['openfoodfacts', 'user_photo', 'retailer'] as const;

/**
 * `identify`: a fresh server identity (strict: https image, server-side sources only). `stored`: an identity the app
 * sent and the server echoes (search result, scans, listings), which may be the user's edit with a device-local photo.
 */
export function checkProductIdentity(v: unknown, path: string, is: Issues, mode: 'identify' | 'stored' = 'stored') {
  const o = obj(v, path, is);
  if (!o) return;
  const id = str(o, 'id', path, is);
  if (id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) is.warn(`${path}.id`, `should be "gtin-" + GTIN-14 like "gtin-07501011123588", or a slug like "doritos-nacho-62g" (the app's productIdFor), got ${show(id)}`);
  str(o, 'brand', path, is);
  str(o, 'productName', path, is);
  for (const key of ['variant', 'size', 'barcode', 'manufacturer', 'categoryGuess']) str(o, key, path, is, { optional: true });
  const imageSource = oneOf(o, 'imageSource', IMAGE_SOURCES, path, is, { optional: true });
  const image = imageSource === 'user_photo' ? str(o, 'imageUrl', path, is, { optional: true }) : httpUrl(o, 'imageUrl', path, is, { optional: true });
  if (image && !imageSource) is.warn(`${path}.imageSource`, 'should say where imageUrl comes from (openfoodfacts images need a CC BY-SA credit)');
  if (imageSource === 'user_photo') {
    if (mode === 'identify') is.error(`${path}.imageSource`, '"user_photo" is a device-local file; only the app may set it');
    else is.warn(`${path}.imageUrl`, "is the scanning phone's local photo, which other phones can't load; drop it or replace it with an Open Food Facts or retailer image");
  }
  num(o, 'confidence', path, is, { min: 0, max: 1 });
  const source = oneOf(o, 'source', IDENTITY_SOURCES, path, is);
  if (mode === 'identify' && (source === 'mock' || source === 'user_edited')) is.warn(`${path}.source`, `a server identity should be "claude" or "openfoodfacts", got ${show(source)}`);
  const alternatives = arr(o, 'alternatives', path, is, { optional: true });
  alternatives?.forEach((a, i) => {
    const p = `${path}.alternatives[${i}]`;
    const ao = obj(a, p, is);
    if (!ao) return;
    str(ao, 'brand', p, is);
    str(ao, 'productName', p, is);
    str(ao, 'variant', p, is, { optional: true });
    str(ao, 'size', p, is, { optional: true });
    num(ao, 'confidence', p, is, { min: 0, max: 1 });
  });
  if (alternatives && alternatives.length > 3) is.warn(`${path}.alternatives`, `the app shows up to 3, got ${alternatives.length}`);
}

export function checkJob(v: unknown, path: string, is: Issues, kind: JobKind): { status?: string; step?: string } {
  const o = obj(v, path, is);
  if (!o) return {};
  str(o, 'jobId', path, is);
  const status = oneOf(o, 'status', ['queued', 'running', 'succeeded', 'failed'] as const, path, is);
  let step: string | undefined;
  if (!absent(o.progress)) {
    const p = obj(o.progress, `${path}.progress`, is);
    if (p) {
      step = str(p, 'step', `${path}.progress`, is);
      str(p, 'message', `${path}.progress`, is, { nonEmpty: false });
      num(p, 'percent', `${path}.progress`, is, { optional: true, min: 0, max: 100 });
      const known = [...STEP_KEYS[kind], 'done'];
      if (step && !known.includes(step)) {
        is.error(`${path}.progress.step`, `must be one of ${known.join(' | ')} for a ${kind} job, got ${show(step)} (the app would stay on its first step)`);
      }
    }
  } else if (status === 'queued' || status === 'running') {
    is.warn(`${path}.progress`, 'should be present while the job runs (the app shows step and message)');
  }
  if (status === 'succeeded' && absent(o.result)) is.error(`${path}.result`, 'is required when status is "succeeded"');
  if (status === 'failed') str(o, 'error', path, is);
  return { status, step };
}

/** `PageAccess.code` (scraper kit `robots.access()`). Other codes are legal but the app can only show their `reason`. */
export const ACCESS_CODES = ['allowed', 'no_robots', 'ai_opt_out', 'robots_disallow', 'robots_unavailable', 'robots_unreachable'] as const;
/** `ScrapeResult.failures[].code` values the app has words for (`FetchFailureCode`). */
export const FAILURE_CODES = ['ai_opt_out', 'robots_disallow', 'robots_unavailable', 'robots_unreachable', 'no_scraper', 'blocked', 'unreachable', 'parse_failed', 'not_in_catalog'] as const;

/** Optional `access` on a page: whether the site lets us collect it. Missing means allowed. */
function checkAccess(o: Obj, path: string, is: Issues) {
  if (absent(o.access)) return;
  const a = obj(o.access, `${path}.access`, is);
  if (!a) return;
  const status = oneOf(a, 'status', ['allowed', 'refused'] as const, `${path}.access`, is);
  const code = str(a, 'code', `${path}.access`, is);
  str(a, 'reason', `${path}.access`, is);
  str(a, 'label', `${path}.access`, is, { optional: true });
  if (!absent(a.alternative)) str(a, 'alternative', `${path}.access`, is);
  if (code && !(ACCESS_CODES as readonly string[]).includes(code)) is.warn(`${path}.access.code`, `is not one of ${ACCESS_CODES.join(' | ')}; the app shows only its reason`);
  if (status === 'refused' && isObj(o.scraper) && o.scraper.status === 'available') {
    is.error(`${path}.scraper.status`, 'must not be "available" on a refused page (it is never built or scraped)');
  }
}

function checkFailure(v: unknown, path: string, is: Issues): Obj | undefined {
  const fo = obj(v, path, is);
  if (!fo) return undefined;
  str(fo, 'pageId', path, is);
  str(fo, 'url', path, is, { nonEmpty: false });
  str(fo, 'error', path, is);
  const code = str(fo, 'code', path, is, { optional: true });
  if (code && !(FAILURE_CODES as readonly string[]).includes(code)) is.warn(`${path}.code`, `is not one of ${FAILURE_CODES.join(' | ')}; the app lists it under "Couldn't fetch" with its error`);
  str(fo, 'retailerName', path, is, { optional: true });
  return fo;
}

const VERIFICATION = ['verified', 'uncertain', 'rejected', 'user_added'] as const;
const SCRAPER_STATUS = ['available', 'missing', 'building', 'failed'] as const;

export function checkSourcePage(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'id', path, is);
  const url = httpUrl(o, 'url', path, is);
  const domain = str(o, 'domain', path, is);
  if (url && domain && domainOf(url) !== domain.toLowerCase().replace(/^www\./, '')) is.warn(`${path}.domain`, `does not match the URL's host (${domainOf(url)})`);
  str(o, 'retailerName', path, is);
  oneOf(o, 'sourceType', ['first_party', 'third_party'] as const, path, is);
  str(o, 'title', path, is);
  const matchType = oneOf(o, 'matchType', ['exact', 'similar'] as const, path, is);
  if (matchType === 'similar') str(o, 'similarProductId', path, is);
  const ver = obj(o.verification, `${path}.verification`, is);
  if (ver) {
    oneOf(ver, 'status', VERIFICATION, `${path}.verification`, is);
    num(ver, 'confidence', `${path}.verification`, is, { min: 0, max: 1 });
    str(ver, 'reason', `${path}.verification`, is);
  }
  const scr = obj(o.scraper, `${path}.scraper`, is);
  if (scr) {
    const status = oneOf(scr, 'status', SCRAPER_STATUS, `${path}.scraper`, is);
    str(scr, 'scraperId', `${path}.scraper`, is, { optional: status !== 'available' });
  }
  checkAccess(o, path, is);
  httpUrl(o, 'thumbnailUrl', path, is, { optional: true });
}

export function checkSimilarProduct(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'id', path, is);
  str(o, 'brand', path, is);
  str(o, 'productName', path, is);
  str(o, 'variant', path, is, { optional: true });
  oneOf(o, 'relation', ['same_brand', 'competitor'] as const, path, is);
  str(o, 'reason', path, is);
  httpUrl(o, 'imageUrl', path, is, { optional: true });
}

export function checkSearchResult(v: unknown, path: string, is: Issues, req: SearchRequest) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'searchId', path, is);
  checkProductIdentity(o.product, `${path}.product`, is);
  if (isObj(o.product) && o.product.id !== req.product.id) is.error(`${path}.product.id`, `must be the id the app sent (${req.product.id}), got ${show(o.product.id)}`);
  const pages = arr(o, 'pages', path, is) ?? [];
  const similar = arr(o, 'similarProducts', path, is) ?? [];
  similar.forEach((s, i) => checkSimilarProduct(s, `${path}.similarProducts[${i}]`, is));
  const similarIds = new Set(similar.filter(isObj).map((s) => s.id));
  const pageIds = new Set<unknown>();
  pages.forEach((p, i) => {
    const pp = `${path}.pages[${i}]`;
    checkSourcePage(p, pp, is);
    if (!isObj(p)) return;
    if (pageIds.has(p.id)) is.error(`${pp}.id`, `is a duplicate (${show(p.id)}); page ids must be unique`);
    pageIds.add(p.id);
    if (p.matchType === 'similar' && !similarIds.has(p.similarProductId)) is.error(`${pp}.similarProductId`, `must be the id of one of similarProducts, got ${show(p.similarProductId)}`);
    if (p.matchType === 'similar' && !req.includeSimilar) is.error(`${pp}.matchType`, 'is "similar" but the request had includeSimilar: false');
    if (req.scanType !== 'both' && p.sourceType !== req.scanType) is.error(`${pp}.sourceType`, `is ${show(p.sourceType)} but the request asked for ${req.scanType} only`);
  });
  if (!req.includeSimilar && similar.length > 0) is.error(`${path}.similarProducts`, 'must be empty when includeSimilar is false');
  if (pages.length === 0) is.warn(`${path}.pages`, 'is empty; with no pages a failed job with a readable error is better (the app shows it with Try again)');
}

export function checkScraperMatches(v: unknown, path: string, is: Issues, urls: string[]) {
  const o = obj(v, path, is);
  if (!o) return;
  const matches = arr(o, 'matches', path, is);
  if (!matches) return;
  if (matches.length !== urls.length) is.error(`${path}.matches`, `must have one match per URL (${urls.length}), got ${matches.length}`);
  matches.forEach((m, i) => {
    const p = `${path}.matches[${i}]`;
    const mo = obj(m, p, is);
    if (!mo) return;
    const url = str(mo, 'url', p, is);
    if (url !== undefined && urls[i] !== undefined && url !== urls[i]) is.error(`${p}.url`, `must be the URL sent at this position (${urls[i]}), got ${show(url)}`);
    str(mo, 'domain', p, is);
    const status = oneOf(mo, 'status', SCRAPER_STATUS, p, is);
    str(mo, 'scraperId', p, is, { optional: status !== 'available' });
  });
}

export function checkBuildResult(v: unknown, path: string, is: Issues, url: string) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'scraperId', path, is);
  const domain = str(o, 'domain', path, is);
  if (domain && domain.toLowerCase().replace(/^www\./, '') !== domainOf(url)) is.warn(`${path}.domain`, `does not match the URL's host (${domainOf(url)})`);
  checkSourcePage(o.page, `${path}.page`, is);
  if (isObj(o.page)) {
    if (o.page.url !== url) is.warn(`${path}.page.url`, `should be the URL the app sent (${url})`);
    if (isObj(o.page.scraper) && o.page.scraper.status !== 'available') is.error(`${path}.page.scraper.status`, 'must be "available" after a successful build');
  }
}

export function checkListing(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'id', path, is);
  str(o, 'pageId', path, is);
  httpUrl(o, 'url', path, is);
  str(o, 'domain', path, is);
  str(o, 'retailerName', path, is);
  str(o, 'title', path, is, { optional: true });
  httpUrl(o, 'imageUrl', path, is, { optional: true });
  if (absent(o.price)) is.warn(`${path}.price`, 'is missing; price is the main thing the results screen shows');
  else {
    const price = obj(o.price, `${path}.price`, is);
    if (price) {
      num(price, 'amount', `${path}.price`, is, { min: 0 });
      const currency = str(price, 'currency', `${path}.price`, is);
      if (currency && currency !== 'MXN') is.warn(`${path}.price.currency`, `region is MX, expected "MXN", got ${show(currency)}`);
    }
  }
  const crumbs = strings(o, 'categoryPath', path, is, { optional: true });
  if (!crumbs) is.warn(`${path}.categoryPath`, "is missing; it should be the retailer's own breadcrumb");
  if (absent(o.standardTaxonomy)) is.warn(`${path}.standardTaxonomy`, 'is missing; map categoryPath to the Google Product Taxonomy');
  else {
    const tax = obj(o.standardTaxonomy, `${path}.standardTaxonomy`, is);
    if (tax) {
      str(tax, 'system', `${path}.standardTaxonomy`, is);
      strings(tax, 'path', `${path}.standardTaxonomy`, is);
      const code = tax.code;
      if (!absent(code) && typeof code !== 'string') is.error(`${path}.standardTaxonomy.code`, `must be a string (e.g. "2392"), got ${show(code)}`);
    }
  }
  const fields = obj(o.fields, `${path}.fields`, is);
  if (fields) {
    for (const [k, val] of Object.entries(fields)) {
      if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) is.error(`${path}.fields.${k}`, `must be string | number | boolean | null (no nesting), got ${show(val)}`);
    }
  }
  isoDate(o, 'scrapedAt', path, is);
}

export function checkScrapeResult(v: unknown, path: string, is: Issues, req: ScrapeRequest) {
  const o = obj(v, path, is);
  if (!o) return;
  str(o, 'runId', path, is);
  if (typeof o.saved !== 'boolean') is.error(`${path}.saved`, `must be a boolean, got ${show(o.saved)}`);
  isoDate(o, 'savedAt', path, is, { optional: o.saved !== true });
  const listings = arr(o, 'listings', path, is) ?? [];
  const failures = arr(o, 'failures', path, is) ?? [];
  const covered = new Set<unknown>();
  listings.forEach((l, i) => {
    checkListing(l, `${path}.listings[${i}]`, is);
    if (!isObj(l)) return;
    if (!req.pageIds.includes(l.pageId as string)) is.error(`${path}.listings[${i}].pageId`, `was not requested (${show(l.pageId)})`);
    if (covered.has(l.pageId)) is.error(`${path}.listings[${i}].pageId`, `has two listings in one run (${show(l.pageId)})`);
    covered.add(l.pageId);
  });
  failures.forEach((f, i) => {
    const fo = checkFailure(f, `${path}.failures[${i}]`, is);
    if (fo) covered.add(fo.pageId);
  });
  for (const id of req.pageIds) if (!covered.has(id)) is.error(`${path}`, `page ${id} is in neither listings nor failures`);
  if (o.saved === true && listings.length === 0) is.warn(`${path}.saved`, 'is true with no listings');
}

export function checkScans(v: unknown, path: string, is: Issues) {
  const o = obj(v, path, is);
  if (!o) return;
  const scans = arr(o, 'scans', path, is) ?? [];
  let previous: string | undefined;
  scans.forEach((s, i) => {
    const p = `${path}.scans[${i}]`;
    const so = obj(s, p, is);
    if (!so) return;
    checkProductIdentity(so.product, `${p}.product`, is);
    isoDate(so, 'lastScrapedAt', p, is, { optional: true });
    num(so, 'listingCount', p, is, { min: 0 });
    const at = typeof so.lastScrapedAt === 'string' ? so.lastScrapedAt : undefined;
    if (previous && at && at > previous) is.warn(`${p}.lastScrapedAt`, 'scans should be newest first');
    if (at) previous = at;
  });
}

export function checkProductListings(v: unknown, path: string, is: Issues, productId: string) {
  const o = obj(v, path, is);
  if (!o) return;
  checkProductIdentity(o.product, `${path}.product`, is);
  if (isObj(o.product) && o.product.id !== productId) is.error(`${path}.product.id`, `must be ${productId}, got ${show(o.product.id)}`);
  const listings = arr(o, 'listings', path, is) ?? [];
  const pageIds = new Set<unknown>();
  listings.forEach((l, i) => {
    checkListing(l, `${path}.listings[${i}]`, is);
    if (!isObj(l)) return;
    if (pageIds.has(l.pageId)) is.error(`${path}.listings[${i}].pageId`, `appears twice (${show(l.pageId)}); keep only the latest listing per page`);
    pageIds.add(l.pageId);
  });
  const failures = arr(o, 'failures', path, is, { optional: true }) ?? [];
  failures.forEach((f, i) => {
    const fo = checkFailure(f, `${path}.failures[${i}]`, is);
    if (fo && pageIds.has(fo.pageId)) is.error(`${path}.failures[${i}].pageId`, `also has a listing (${show(fo.pageId)}); list only pages with no listing since they failed`);
  });
}
