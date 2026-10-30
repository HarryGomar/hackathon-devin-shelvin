// Mock data for demo mode. Barcodes, URLs and prices are FICTIONAL / illustrative only; product photos are real (Open Food Facts).

import type { Listing, PageAccess, ProductIdentity, ScanType, ScrapeFailure, SimilarProduct, SourcePage } from '../types';

export const SAMPLE_BARCODES = {
  doritosIncognita: '7500000000017',
  takisFuego: '7500000000024',
} as const;

/** Real Open Food Facts front images (CC BY-SA, credit "Open Food Facts"); the pack may differ in size from the mock. */
const offImage = (path: string) => `https://images.openfoodfacts.org/images/products/${path}.400.jpg`;

export const PRODUCTS: Record<string, ProductIdentity> = {
  'doritos-incognita': {
    id: 'doritos-incognita',
    brand: 'Doritos',
    productName: 'Doritos Incógnita',
    variant: 'Incógnita',
    size: '62 g',
    barcode: SAMPLE_BARCODES.doritosIncognita,
    manufacturer: 'Sabritas (PepsiCo México)',
    categoryGuess: 'Botanas › Totopos',
    imageUrl: offImage('750/047/801/2138/front_es.7'),
    imageSource: 'openfoodfacts',
    confidence: 0.95,
    source: 'mock',
  },
  'takis-fuego': {
    id: 'takis-fuego',
    brand: 'Takis',
    productName: 'Takis Fuego',
    variant: 'Fuego',
    size: '90 g',
    barcode: SAMPLE_BARCODES.takisFuego,
    manufacturer: 'Barcel (Grupo Bimbo)',
    categoryGuess: 'Botanas › Tortilla enrollada',
    imageUrl: offImage('750/081/000/3671/front_es.30'),
    imageSource: 'openfoodfacts',
    confidence: 0.94,
    source: 'mock',
  },
  'doritos-nacho': {
    id: 'doritos-nacho',
    brand: 'Doritos',
    productName: 'Doritos Nacho',
    variant: 'Nacho',
    size: '62 g',
    manufacturer: 'Sabritas (PepsiCo México)',
    categoryGuess: 'Botanas › Totopos',
    imageUrl: offImage('750/101/112/3588/front_es.30'),
    imageSource: 'openfoodfacts',
    confidence: 0.93,
    source: 'mock',
  },
  'doritos-flamin-hot': {
    id: 'doritos-flamin-hot',
    brand: 'Doritos',
    productName: "Doritos Flamin' Hot",
    variant: "Flamin' Hot",
    size: '62 g',
    manufacturer: 'Sabritas (PepsiCo México)',
    categoryGuess: 'Botanas › Totopos',
    // No photo: Open Food Facts only has "Xtra Flamin' Hot", another version (the tile shows initials).
    confidence: 0.92,
    source: 'mock',
  },
  'tostitos-salsa-verde': {
    id: 'tostitos-salsa-verde',
    brand: 'Tostitos',
    productName: 'Tostitos Salsa Verde',
    variant: 'Salsa Verde',
    size: '65 g',
    manufacturer: 'Sabritas (PepsiCo México)',
    categoryGuess: 'Botanas › Totopos',
    imageUrl: offImage('750/101/112/7012/front_es.15'),
    imageSource: 'openfoodfacts',
    confidence: 0.9,
    source: 'mock',
  },
};

/** Similar products shown for each main product. */
export const SIMILAR: Record<string, SimilarProduct[]> = {
  'doritos-incognita': [
    { id: 'doritos-nacho', brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', relation: 'same_brand', reason: 'Same line, different flavor' },
    { id: 'doritos-flamin-hot', brand: 'Doritos', productName: "Doritos Flamin' Hot", variant: "Flamin' Hot", relation: 'same_brand', reason: 'Same line, spicy flavor' },
    { id: 'takis-fuego', brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', relation: 'competitor', reason: 'Competing rolled tortilla chip' },
    { id: 'tostitos-salsa-verde', brand: 'Tostitos', productName: 'Tostitos Salsa Verde', variant: 'Salsa Verde', relation: 'competitor', reason: 'Related tortilla chip, different brand' },
  ],
  'takis-fuego': [
    { id: 'doritos-flamin-hot', brand: 'Doritos', productName: "Doritos Flamin' Hot", variant: "Flamin' Hot", relation: 'competitor', reason: 'Competing spicy tortilla chip' },
    { id: 'doritos-incognita', brand: 'Doritos', productName: 'Doritos Incógnita', variant: 'Incógnita', relation: 'competitor', reason: 'Competing tortilla chip' },
  ],
};

interface RetailerFixture {
  key: string;
  domain: string;
  retailerName: string;
  path: (slug: string) => string;
  verification: SourcePage['verification'];
  scraper: SourcePage['scraper'];
  categoryPath: string[];
  priceFactor: number;
  extraFields: Record<string, string | number | boolean | null>;
  /** Scraping this store's pages fails in the mock: fixture pages only, unless `everyPage`. */
  scrapeFails?: Pick<ScrapeFailure, 'code' | 'error'> & { everyPage?: boolean };
  /**
   * The site refuses automated collection, as the backend finds it (scraper-kit README), so it holds for every page
   * on the domain.
   */
  access?: PageAccess;
}

const AI_OPT_OUT = (agents: string, alternative: string | null): PageAccess => ({
  status: 'refused',
  code: 'ai_opt_out',
  label: 'Blocks AI agents',
  reason: `robots.txt blocks AI agents (${agents})`,
  alternative,
});

const ALLOWED: PageAccess = { status: 'allowed', code: 'allowed', reason: 'robots.txt allows this page' };

export const RETAILERS: RetailerFixture[] = [
  {
    key: 'walmart',
    domain: 'super.walmart.com.mx',
    retailerName: 'Walmart Súper',
    path: (s) => `/ip/${s}/00750000000001`,
    verification: { status: 'verified', confidence: 0.96, reason: 'Same brand, flavor and size on the page' },
    scraper: { status: 'available', scraperId: 'scr-walmart-mx' },
    categoryPath: ['Despensa', 'Botanas', 'Papas y totopos'],
    priceFactor: 1,
    extraFields: { availability: 'In stock', rating: 4.7, review_count: 312, sku: 'WM-00750000000001', pickup_today: true },
  },
  {
    key: 'soriana',
    domain: 'soriana.com',
    retailerName: 'Soriana',
    path: (s) => `/${s}/p`,
    verification: { status: 'verified', confidence: 0.91, reason: 'Title and barcode match' },
    scraper: { status: 'available', scraperId: 'scr-soriana' },
    categoryPath: ['Despensa', 'Botanas y Dulces', 'Botanas Saladas'],
    priceFactor: 1.04,
    extraFields: { availability: 'In stock', promo: '3 x 2 en botanas', net_weight: '62 g', sku: 'SOR-115606', gtin: 7500000115606, review_count: 1240 },
  },
  {
    key: 'chedraui',
    domain: 'chedraui.com.mx',
    retailerName: 'Chedraui',
    path: (s) => `/${s}-3216/p`,
    verification: { status: 'verified', confidence: 0.88, reason: 'Same product, image matches the package' },
    scraper: { status: 'missing' },
    categoryPath: ['Súper', 'Botanas', 'Totopos'],
    priceFactor: 0.98,
    extraFields: { availability: 'Low stock', unit_price: '$29.03 / 100 g', delivery: 'Same day' },
  },
  {
    key: 'lacomer',
    domain: 'lacomer.com.mx',
    retailerName: 'La Comer',
    path: (s) => `/lacomer/#!/detarticulo/${s}`,
    verification: { status: 'verified', confidence: 0.82, reason: 'Title matches; size listed as 62 g' },
    scraper: { status: 'missing' },
    categoryPath: ['Abarrotes', 'Botanas', 'Frituras de maíz'],
    priceFactor: 1.08,
    extraFields: { availability: 'In stock', net_weight: '62 g', organic: false },
  },
  {
    key: 'bodega',
    domain: 'despensa.bodegaaurrera.com.mx',
    retailerName: 'Bodega Aurrera Despensa',
    path: (s) => `/ip/${s}/00750000000001`,
    verification: { status: 'verified', confidence: 0.85, reason: 'Same product sold by Walmart group' },
    scraper: { status: 'available', scraperId: 'scr-bodega' },
    categoryPath: ['Abarrotes', 'Botanas'],
    priceFactor: 0.95,
    extraFields: {},
    scrapeFails: { code: 'unreachable', error: 'Timed out loading the page (mock failure)', everyPage: true },
  },
  {
    key: 'heb',
    domain: 'heb.com.mx',
    retailerName: 'HEB México',
    path: (s) => `/${s}-7501/p`,
    verification: { status: 'verified', confidence: 0.87, reason: 'Title and size match' },
    scraper: { status: 'available', scraperId: 'scr-heb' },
    categoryPath: ['Despensa', 'Botanas', 'Totopos'],
    priceFactor: 1.02,
    extraFields: {},
    scrapeFails: { code: 'blocked', error: 'The site answered 403 Forbidden, so the run stopped (mock refusal)' },
  },
  {
    key: 'amazon',
    domain: 'amazon.com.mx',
    retailerName: 'Amazon México',
    path: (s) => `/dp/B0MOCK${s.length}`,
    verification: { status: 'uncertain', confidence: 0.6, reason: 'Listing shows a 6-pack; size per bag may differ' },
    scraper: { status: 'missing' },
    categoryPath: ['Alimentos y Bebidas', 'Botanas', 'Totopos'],
    priceFactor: 5.6,
    extraFields: { pack_size: 6, rating: 4.4, review_count: 87, prime: true },
    access: AI_OPT_OUT('ClaudeBot, GPTBot, PerplexityBot', "Amazon's Creators API (needs an Amazon Associates México account)"),
  },
  {
    key: 'mercadolibre',
    domain: 'mercadolibre.com.mx',
    retailerName: 'Mercado Libre',
    path: (s) => `/MLM-0000-${s}-_JM`,
    verification: { status: 'rejected', confidence: 0.2, reason: 'Reseller bundle mixed with other snacks, not the same product' },
    scraper: { status: 'missing' },
    categoryPath: ['Alimentos y Bebidas', 'Snacks'],
    priceFactor: 3,
    extraFields: {},
    access: AI_OPT_OUT('ClaudeBot, GPTBot', "Mercado Libre's developer API with an OAuth token"),
  },
];

/** Sites whose scraper build fails the gate on attempt 1; the gate's report goes back and attempt 2 passes. */
export const FLAKY_BUILD_DOMAINS = new Set(['lacomer.com.mx']);
/** Sites whose build fails the gate 3 times (needs a person). Paste a 7-Eleven page in Add a page to see it. */
export const FAILING_BUILD_DOMAINS = new Set(['7-eleven.com.mx']);

const BASE_PRICE: Record<string, number> = {
  'doritos-incognita': 18,
  'takis-fuego': 24,
  'doritos-nacho': 18,
  'doritos-flamin-hot': 18.5,
  'tostitos-salsa-verde': 19,
};

export const STANDARD_TAXONOMY = {
  system: 'Google Product Taxonomy',
  path: ['Food, Beverages & Tobacco', 'Food Items', 'Snack Foods', 'Chips'],
};

/** The brand's own list price for a product in the mock (its catalog rows show it). */
export function listPrice(productId: string): number {
  return BASE_PRICE[productId] ?? 20;
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function brandDomain(product: ProductIdentity) {
  return `${slugify(product.brand)}.com.mx`;
}

function firstPartyPage(product: ProductIdentity, matchType: SourcePage['matchType'], similarProductId?: string): SourcePage {
  const domain = brandDomain(product);
  return {
    id: `${product.id}--first-party`,
    url: `https://${domain}/productos/${slugify(product.productName)}`,
    domain,
    retailerName: `${product.brand} (official site)`,
    sourceType: 'first_party',
    title: `${product.productName} | ${product.brand} México`,
    matchType,
    similarProductId,
    verification: { status: 'verified', confidence: 0.97, reason: "Brand's official product page" },
    scraper: { status: 'available', scraperId: `scr-${slugify(product.brand)}-official` },
    access: ALLOWED,
  };
}

function retailerPage(product: ProductIdentity, r: RetailerFixture, matchType: SourcePage['matchType'], similarProductId?: string): SourcePage {
  const slug = slugify(`${product.productName} ${product.size ?? ''}`);
  return {
    id: `${product.id}--${r.key}`,
    url: `https://${r.domain}${r.path(slug)}`,
    domain: r.domain,
    retailerName: r.retailerName,
    sourceType: 'third_party',
    title: `${product.productName} ${product.size ?? ''} - ${r.retailerName}`.replace(/\s+/g, ' '),
    matchType,
    similarProductId,
    verification: { ...r.verification },
    scraper: { ...r.scraper },
    access: r.access ?? ALLOWED,
  };
}

/** Pages the "agent" finds for a product, filtered by scan type. */
export function buildPages(product: ProductIdentity, scanType: ScanType, includeSimilar: boolean): SourcePage[] {
  const pages: SourcePage[] = [];
  const wantFirst = scanType !== 'third_party';
  const wantThird = scanType !== 'first_party';
  if (wantFirst) pages.push(firstPartyPage(product, 'exact'));
  if (wantThird) for (const r of RETAILERS) pages.push(retailerPage(product, r, 'exact'));

  if (includeSimilar) {
    for (const s of similarFor(product)) {
      const sp = PRODUCTS[s.id];
      if (!sp) continue;
      if (wantFirst) pages.push(firstPartyPage(sp, 'similar', s.id));
      if (wantThird) {
        for (const r of RETAILERS.filter((x) => x.key === 'walmart' || x.key === 'soriana')) {
          pages.push(retailerPage(sp, r, 'similar', s.id));
        }
      }
    }
  }
  return pages;
}

export function similarFor(product: ProductIdentity): SimilarProduct[] {
  const list = SIMILAR[product.id] ?? SIMILAR['doritos-incognita'].filter((s) => s.id !== product.id);
  return list.map((s) => ({ ...s, imageUrl: s.imageUrl ?? PRODUCTS[s.id]?.imageUrl }));
}

export function retailerForDomain(domain: string) {
  return RETAILERS.find((r) => r.domain === domain);
}

/**
 * The product image a scraper would read off each fixture page. In the real app listing images come from the
 * backend (the retailer's own image); these Open Food Facts URLs are only stand-ins for the mock.
 */
const SCRAPED_IMAGES: Record<string, string> = {
  'doritos-incognita': offImage('750/047/801/2138/front_es.7'),
  'takis-fuego': offImage('750/081/000/3671/front_es.30'),
  'doritos-nacho': offImage('750/101/112/3588/front_es.30'),
  'tostitos-salsa-verde': offImage('750/101/112/7012/front_es.15'),
};

/**
 * The scraped image for a page: only fixture pages (`<productId>--<store>`) have one. Pages found by a live search
 * (`web-…`) or added by the user get none, and the identified product's photo is never copied into a listing.
 */
export function scrapedImageFor(page: SourcePage): string | undefined {
  const productId = page.id.includes('--') ? page.id.split('--')[0] : undefined;
  return productId ? SCRAPED_IMAGES[productId] : undefined;
}

/** The listing a scraper would return for a page; `imageUrl` comes from the page, never from `product`. */
export function buildListing(page: SourcePage, product: ProductIdentity, now: Date): Listing {
  const scrapedAt = now.toISOString();
  if (page.sourceType === 'first_party') {
    return {
      id: `lst-${page.id}-${now.getTime()}`,
      pageId: page.id,
      url: page.url,
      domain: page.domain,
      retailerName: page.retailerName,
      title: product.productName,
      imageUrl: scrapedImageFor(page),
      categoryPath: ['Productos', product.brand, 'Botanas'],
      standardTaxonomy: STANDARD_TAXONOMY,
      fields: {
        net_weight: product.size ?? null,
        manufacturer: product.manufacturer ?? null,
        description: `Totopos de maíz sabor ${product.variant ?? 'original'}.`,
        allergens: 'Contiene leche y soya',
        calories_per_portion: 150,
      },
      scrapedAt,
    };
  }
  const retailer = retailerForDomain(page.domain);
  const base = BASE_PRICE[product.id] ?? 20;
  const amount = Math.round(base * (retailer?.priceFactor ?? 1) * 100) / 100;
  return {
    id: `lst-${page.id}-${now.getTime()}`,
    pageId: page.id,
    url: page.url,
    domain: page.domain,
    retailerName: page.retailerName,
    title: page.title,
    imageUrl: scrapedImageFor(page),
    price: { amount, currency: 'MXN' },
    categoryPath: retailer?.categoryPath ?? categoryFrom(product),
    standardTaxonomy: STANDARD_TAXONOMY,
    fields: { ...(retailer?.extraFields ?? { availability: 'In stock' }) },
    scrapedAt,
  };
}

/** Generic breadcrumb for a store with no fixture: the identified category, e.g. "Botanas > Totopos". */
function categoryFrom(product: ProductIdentity): string[] {
  const path = (product.categoryGuess ?? '').split(/\s*[>›]\s*/).filter(Boolean);
  return path.length > 0 ? path : ['Botanas'];
}

/** Fixture pages are `<productId>--<store>`; pages from a live search are `web-…`, pages the user added `user--…`. */
function isFixturePage(page: Pick<SourcePage, 'id'>) {
  return page.id.includes('--') && !page.id.startsWith('user--');
}

/** Why scraping this page fails in the mock (with a scraper). A made-up refusal is never claimed for a real page. */
export function scrapeFailureFor(page: SourcePage): Omit<ScrapeFailure, 'pageId' | 'url'> | undefined {
  const fail = retailerForDomain(page.domain)?.scrapeFails;
  if (!fail || !(fail.everyPage || isFixturePage(page))) return undefined;
  return { code: fail.code, error: fail.error, retailerName: page.retailerName };
}

/** The site's refusal for any page on `domain`, if the backend found one. */
export function refusedAccess(domain: string): PageAccess | undefined {
  return retailerForDomain(domain)?.access;
}
