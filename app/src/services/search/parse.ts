/**
 * Pure prompt building, parsing and validation for the Claude page search. No runtime imports, so it runs under
 * `node --test` (see parse.test.ts) as well as in the app.
 */
import type { ProductIdentity, SearchRequest, SimilarProduct, SourcePage, VerificationStatus } from '@/api/types';

/** Mexican retailers Claude may return as third-party pages. Most specific domain first. */
export const MX_RETAILERS: readonly { key: string; domain: string; retailerName: string }[] = [
  { key: 'walmart', domain: 'super.walmart.com.mx', retailerName: 'Walmart Súper' },
  { key: 'walmart-mx', domain: 'walmart.com.mx', retailerName: 'Walmart México' },
  { key: 'soriana', domain: 'soriana.com', retailerName: 'Soriana' },
  { key: 'chedraui', domain: 'chedraui.com.mx', retailerName: 'Chedraui' },
  { key: 'lacomer', domain: 'lacomer.com.mx', retailerName: 'La Comer' },
  { key: 'bodega', domain: 'despensa.bodegaaurrera.com.mx', retailerName: 'Bodega Aurrera Despensa' },
  { key: 'bodega-mx', domain: 'bodegaaurrera.com.mx', retailerName: 'Bodega Aurrera' },
  { key: 'heb', domain: 'heb.com.mx', retailerName: 'HEB México' },
  { key: 'amazon', domain: 'amazon.com.mx', retailerName: 'Amazon México' },
  { key: 'mercadolibre', domain: 'mercadolibre.com.mx', retailerName: 'Mercado Libre' },
];

/** Searched domains for retailers (subdomains are covered, so the parents are enough). */
const RETAILER_SEARCH_DOMAINS = [
  'walmart.com.mx',
  'soriana.com',
  'chedraui.com.mx',
  'lacomer.com.mx',
  'bodegaaurrera.com.mx',
  'heb.com.mx',
  'amazon.com.mx',
  'mercadolibre.com.mx',
];

/** Kept out of the open search for the brand's own page (first-party only scans). */
const FIRST_PARTY_BLOCKED = [
  ...RETAILER_SEARCH_DOMAINS,
  'walmart.com',
  'amazon.com',
  'mercadolibre.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'x.com',
  'wikipedia.org',
  'openfoodfacts.org',
  'profeco.gob.mx',
];

export type SearchErrorCode = 'refusal' | 'truncated' | 'incomplete' | 'invalid_output' | 'no_results';

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(message: string, code: SearchErrorCode) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

/** "example.com" or "www.Example.com/x" → "example.com". */
export function domainOf(url: string): string {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return (match?.[1] ?? '').toLowerCase().replace(/^www\./, '');
}

/** Host + path without protocol, www, query, hash or trailing slash: the key for dedupe and "seen in results". */
export function normalizeUrl(url: string): string {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url.trim());
  if (!match) return url.trim().toLowerCase();
  const host = match[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  return `${host}${match[2].replace(/\/+$/, '')}`;
}

function onDomain(domain: string, parent: string) {
  return domain === parent || domain.endsWith(`.${parent}`);
}

export function retailerFor(domain: string) {
  return MX_RETAILERS.find((r) => onDomain(domain, r.domain));
}

function slug(text: string) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** FNV-1a, base 36: short stable ids from URLs. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Stable page id from its URL. */
export function pageIdFor(url: string): string {
  return `web-${slug(domainOf(url)) || 'page'}-${hash(normalizeUrl(url))}`;
}

/**
 * Likely official domains for the brand and maker, e.g. Doritos / "Sabritas (PepsiCo México)" →
 * doritos.com.mx, doritos.com, sabritas.com.mx, … Search ignores ones that don't exist.
 */
export function brandDomainGuesses(product: ProductIdentity): string[] {
  const names = [product.brand, ...(product.manufacturer ?? '').split(/[()]/)]
    .map((n) => n.replace(/\b(m[eé]xico|s\.?a\.?|de c\.?v\.?|grupo)\b/gi, '').trim())
    .filter((n) => n.length > 1);
  const roots = new Set<string>();
  for (const name of names) {
    const s = slug(name);
    if (!s) continue;
    roots.add(s.replace(/-/g, ''));
    if (s.includes('-')) roots.add(s);
    const first = s.split('-')[0];
    if (first.length > 2) roots.add(first);
  }
  return [...roots].slice(0, 6).flatMap((r) => [`${r}.com.mx`, `${r}.com`]);
}

export interface DomainPolicy {
  allowed?: string[];
  blocked?: string[];
}

/** Third party: only the retailers. Both: retailers + the brand's likely domains. First party: open search minus retailers and noise. */
export function domainPolicy(req: Pick<SearchRequest, 'product' | 'scanType'>): DomainPolicy {
  if (req.scanType === 'third_party') return { allowed: [...RETAILER_SEARCH_DOMAINS] };
  if (req.scanType === 'first_party') return { blocked: [...FIRST_PARTY_BLOCKED] };
  return { allowed: [...RETAILER_SEARCH_DOMAINS, ...brandDomainGuesses(req.product)] };
}

function allowedByPolicy(domain: string, policy: DomainPolicy) {
  if (policy.allowed) return policy.allowed.some((d) => onDomain(domain, d));
  if (policy.blocked) return !policy.blocked.some((d) => onDomain(domain, d));
  return true;
}

/** Number of web searches allowed per request. */
export function maxSearches(req: Pick<SearchRequest, 'includeSimilar'>) {
  return req.includeSimilar ? 8 : 6;
}

const pageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'title', 'retailerName', 'sourceType', 'verdict', 'confidence', 'reason'],
  properties: {
    url: { type: 'string', description: 'Exact URL from the search results.' },
    title: { type: 'string', description: 'Page title as shown in the search result.' },
    retailerName: { type: 'string', description: 'Store or brand name, e.g. "Soriana" or "Doritos (sitio oficial)".' },
    sourceType: { type: 'string', enum: ['first_party', 'third_party'] },
    verdict: { type: 'string', enum: ['verified', 'uncertain', 'rejected'] },
    confidence: { type: 'number', description: '0..1 that the page sells exactly this product.' },
    reason: { type: 'string', description: 'One short English line: same brand, flavor and size?' },
  },
} as const;

/** JSON schema for the answer (`output_config.format`). */
export const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'similarProducts'],
  properties: {
    pages: { type: 'array', description: 'Pages for the requested product.', items: pageSchema },
    similarProducts: {
      type: 'array',
      description: 'Similar products, only when asked. Empty otherwise.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['brand', 'productName', 'variant', 'relation', 'reason', 'pages'],
        properties: {
          brand: { type: 'string' },
          productName: { type: 'string', description: 'Name including brand, without the size, e.g. "Doritos Incógnita".' },
          variant: { type: 'string', description: 'Flavor or variant, "" if none.' },
          relation: { type: 'string', enum: ['same_brand', 'competitor'] },
          reason: { type: 'string', description: 'One short English line on why it is similar.' },
          pages: { type: 'array', description: '1 or 2 product pages.', items: pageSchema },
        },
      },
    },
  },
} as const;

export const SEARCH_SYSTEM = `You find real product pages for one packaged retail product sold in Mexico, using the web_search tool.
Return only product detail pages: a page about this one product. Never return search results pages, category pages, store home pages, recipes, news or PDFs.
Copy each URL exactly as it appears in the search results. Never invent, guess or edit a URL; leave a store out rather than guess.
Verify each page against the product from its title and snippet:
- verified: same brand, same flavor or variant, and same size.
- uncertain: probably the same product, but the size or flavor is not shown, or the page is for a different pack size of the same product.
- rejected: a different flavor, a multipack or bundle mixed with other products, or a different product. Include at most 2 rejected near misses.
confidence is how likely it is that the page sells exactly this product. reason is one short English line.
first_party means the brand's or manufacturer's own website. third_party means a store.
Spend your searches well: product name plus size works better than one search per store. Search for the requested product first and spend most searches on it; similar products come last.
Your final answer is only the JSON object, with no text around it.`;

const SCAN_TYPE_ASK: Record<SearchRequest['scanType'], string> = {
  first_party: "Find only the brand's official product page (first party). Do not return store pages.",
  third_party: 'Find only Mexican store product pages (third party). Do not return the brand site.',
  both: "Find the brand's official product page (first party) and Mexican store product pages (third party).",
};

/** The user turn: the product, what to look for, where and how many searches. */
export function buildSearchPrompt(req: SearchRequest): string {
  const p = req.product;
  const lines = [
    'Product:',
    `- Brand: ${p.brand}`,
    `- Name: ${p.productName}`,
    p.variant ? `- Flavor/variant: ${p.variant}` : undefined,
    p.size ? `- Size: ${p.size}` : undefined,
    p.barcode ? `- Barcode (EAN/UPC): ${p.barcode}` : undefined,
    p.manufacturer ? `- Manufacturer: ${p.manufacturer}` : undefined,
    '',
    SCAN_TYPE_ASK[req.scanType],
  ];
  if (req.scanType !== 'first_party') {
    lines.push(`Stores to look at: ${MX_RETAILERS.filter((r) => !r.key.endsWith('-mx')).map((r) => r.retailerName).join(', ')}. Up to one page per store.`);
  }
  lines.push(
    req.includeSimilar
      ? 'Also give 2 to 4 similar products (other flavors of the same brand, and competitors) with 1 or 2 pages each, of the same kind as above.'
      : 'Return an empty similarProducts list.',
    `You have at most ${maxSearches(req)} searches.`,
  );
  return lines.filter((l) => l !== undefined).join('\n');
}

/** The parts of a Messages API response we read (keeps this file SDK-free for tests). */
export interface SearchResponseLike {
  stop_reason: string | null;
  content: readonly unknown[];
}

/** Every URL that came back from a search tool result (or a text citation) anywhere in the content. */
export function collectSeenUrls(content: readonly unknown[]): Set<string> {
  const seen = new Set<string>();
  const walk = (v: unknown, inResult: boolean) => {
    if (typeof v === 'string') {
      // Dynamic filtering can hand results back as code output text.
      if (inResult) for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) seen.add(normalizeUrl(m[0]));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, inResult);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const isResult = inResult || (typeof o.type === 'string' && (o.type.endsWith('_tool_result') || o.type.endsWith('_result_location')));
    if (isResult && typeof o.url === 'string') seen.add(normalizeUrl(o.url));
    for (const [k, child] of Object.entries(o)) if (k !== 'url') walk(child, isResult || k === 'citations');
  };
  walk(content, false);
  return seen;
}

/** The final answer text: text blocks after the last tool activity (or all text when there is none). */
function answerText(content: readonly unknown[]): string {
  const blocks = content.map((b) => (b && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }) : {}));
  let start = 0;
  blocks.forEach((b, i) => {
    if (typeof b.type === 'string' && b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking') start = i + 1;
  });
  const pick = (from: number) =>
    blocks
      .slice(from)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  return pick(start).trim() || pick(0).trim();
}

/** JSON.parse, tolerating a code fence or words around the object (when structured output is off). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(t.slice(first, last + 1));
      } catch {
        // fall through
      }
    }
    throw new SearchError('The search returned an answer the app could not read', 'invalid_output');
  }
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n > 1 && n <= 100 ? n / 100 : n));
}

const VERDICTS: readonly VerificationStatus[] = ['verified', 'uncertain', 'rejected'];
const STATUS_RANK: Record<VerificationStatus, number> = { user_added: 0, verified: 1, uncertain: 2, rejected: 3 };

/** Caps on what is shown. */
export const LIMITS = { exactPages: 12, similarProducts: 4, pagesPerSimilar: 2 } as const;

interface PageContext {
  req: SearchRequest;
  policy: DomainPolicy;
  seen: Set<string>;
}

function toPage(raw: unknown, ctx: PageContext, matchType: SourcePage['matchType'], similarProductId?: string): SourcePage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const url = str(o.url);
  if (!url || !/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(url)) return undefined;
  const domain = domainOf(url);
  if (!allowedByPolicy(domain, ctx.policy)) return undefined;

  // The domain decides the type: a known store is third party; anything else must be the brand's own site.
  const retailer = retailerFor(domain);
  if (!retailer && o.sourceType === 'third_party') return undefined;
  const sourceType: SourcePage['sourceType'] = retailer ? 'third_party' : 'first_party';
  if (ctx.req.scanType !== 'both' && ctx.req.scanType !== sourceType) return undefined;

  let status: VerificationStatus = VERDICTS.includes(o.verdict as VerificationStatus) ? (o.verdict as VerificationStatus) : 'uncertain';
  let confidence = clamp01(o.confidence);
  let reason = str(o.reason) ?? (status === 'verified' ? 'Same brand, flavor and size' : 'Not confirmed on the page');
  if (ctx.seen.size > 0 && !ctx.seen.has(normalizeUrl(url))) {
    // Claude named a URL the search never returned: keep it, but don't call it verified.
    if (status === 'verified') status = 'uncertain';
    confidence = Math.min(confidence, 0.5);
    reason = `Not seen in search results. ${reason}`;
  }

  return {
    id: pageIdFor(url),
    url,
    domain,
    retailerName: retailer?.retailerName ?? str(o.retailerName) ?? `${ctx.req.product.brand} (official site)`,
    sourceType,
    title: str(o.title) ?? url,
    matchType,
    similarProductId,
    verification: { status, confidence, reason },
    scraper: { status: 'missing' },
  };
}

function byRank(a: SourcePage, b: SourcePage) {
  return (
    (a.matchType === b.matchType ? 0 : a.matchType === 'exact' ? -1 : 1) ||
    (a.sourceType === b.sourceType ? 0 : a.sourceType === 'first_party' ? -1 : 1) ||
    STATUS_RANK[a.verification.status] - STATUS_RANK[b.verification.status] ||
    b.verification.confidence - a.verification.confidence
  );
}

/** Same URL twice: keep the better-ranked copy. */
function dedupe(pages: SourcePage[]) {
  const out = new Map<string, SourcePage>();
  for (const p of [...pages].sort(byRank)) if (!out.has(p.id)) out.set(p.id, p);
  return [...out.values()];
}

export interface ParsedSearch {
  pages: SourcePage[];
  similarProducts: SimilarProduct[];
}

/** Validate Claude's JSON object into contract pages and similar products, ranked. Throws SearchError. */
export function parseSearchAnswer(raw: unknown, req: SearchRequest, seen: Set<string> = new Set()): ParsedSearch {
  if (!raw || typeof raw !== 'object') throw new SearchError('The search returned no data', 'invalid_output');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.pages)) throw new SearchError('The search returned an answer the app could not read', 'invalid_output');
  const ctx: PageContext = { req, policy: domainPolicy(req), seen };

  const exact = dedupe(o.pages.map((p) => toPage(p, ctx, 'exact')).filter((p): p is SourcePage => !!p)).slice(0, LIMITS.exactPages);

  const similarProducts: SimilarProduct[] = [];
  const similarPages: SourcePage[] = [];
  const mainId = slug(`${req.product.productName} ${req.product.variant ?? ''}`);
  if (req.includeSimilar && Array.isArray(o.similarProducts)) {
    for (const s of o.similarProducts) {
      if (similarProducts.length >= LIMITS.similarProducts) break;
      if (!s || typeof s !== 'object') continue;
      const sp = s as Record<string, unknown>;
      const brand = str(sp.brand);
      const productName = str(sp.productName);
      if (!brand || !productName) continue;
      const variant = str(sp.variant);
      const key = slug(`${productName} ${variant ?? ''}`);
      if (key === mainId) continue;
      const id = `similar-${key}`;
      if (similarProducts.some((x) => x.id === id)) continue;
      similarProducts.push({
        id,
        brand,
        productName,
        variant,
        relation: sp.relation === 'same_brand' || sp.relation === 'competitor' ? sp.relation : brand.toLowerCase() === req.product.brand.toLowerCase() ? 'same_brand' : 'competitor',
        reason: str(sp.reason) ?? 'Similar product',
      });
      const pages = (Array.isArray(sp.pages) ? sp.pages : []).map((p) => toPage(p, ctx, 'similar', id)).filter((p): p is SourcePage => !!p);
      similarPages.push(...dedupe(pages).slice(0, LIMITS.pagesPerSimilar));
    }
  }

  const exactIds = new Set(exact.map((p) => p.id));
  const pages = [...exact, ...dedupe(similarPages).filter((p) => !exactIds.has(p.id))].sort(byRank);
  if (pages.length === 0) {
    throw new SearchError(`No store pages found for ${req.product.productName}. Check the name and size, then try again.`, 'no_results');
  }
  return { pages, similarProducts };
}

/** Check stop_reason, read the final JSON answer and validate it. Throws SearchError. */
export function parseSearchResponse(res: SearchResponseLike, req: SearchRequest): ParsedSearch {
  if (res.stop_reason === 'refusal') throw new SearchError('Claude declined to search for this product', 'refusal');
  if (res.stop_reason === 'max_tokens') throw new SearchError('The search answer was cut off', 'truncated');
  if (res.stop_reason === 'pause_turn') throw new SearchError('The search did not finish in time. Try again.', 'incomplete');
  const text = answerText(res.content);
  if (!text) throw new SearchError('The search returned no answer', 'invalid_output');
  return parseSearchAnswer(extractJson(text), req, collectSeenUrls(res.content));
}
