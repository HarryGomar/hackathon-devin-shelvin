/**
 * Pure parsing/validation for product identification. No runtime imports, so it runs under
 * `node --test` (see parse.test.ts) as well as in the app.
 */
import type { ProductIdentity } from '@/api/types';

import { productIdFor, productSlug } from './gtin';

/** JSON schema Claude must follow (`output_config.format`). Unknown text fields are "". */
export const IDENTITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brand', 'productName', 'variant', 'size', 'manufacturer', 'categoryGuess', 'confidence', 'alternatives'],
  properties: {
    brand: { type: 'string', description: 'Brand as printed, e.g. "Doritos". "" if no product is visible.' },
    productName: { type: 'string', description: 'Full product name including brand, as printed, e.g. "Doritos Incógnita".' },
    variant: { type: 'string', description: 'Flavor or variant, e.g. "Incógnita". "" if none.' },
    size: { type: 'string', description: 'Net content with unit, e.g. "62 g". "" if unknown.' },
    manufacturer: { type: 'string', description: 'Company, e.g. "Sabritas (PepsiCo México)". "" if unknown.' },
    categoryGuess: { type: 'string', description: 'Spanish shelf category path joined with " > ", e.g. "Botanas > Totopos".' },
    confidence: { type: 'number', description: 'Probability 0..1 that this is exactly the product.' },
    alternatives: {
      type: 'array',
      description: 'Up to 3 other plausible products, most likely first. Empty when sure.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['brand', 'productName', 'variant', 'size', 'confidence'],
        properties: {
          brand: { type: 'string' },
          productName: { type: 'string' },
          variant: { type: 'string' },
          size: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export type IdentifyErrorCode = 'not_a_product' | 'invalid_output' | 'refusal' | 'truncated' | 'not_found';

export class IdentifyError extends Error {
  readonly code: IdentifyErrorCode;

  constructor(message: string, code: IdentifyErrorCode) {
    super(message);
    this.name = 'IdentifyError';
    this.code = code;
  }
}

export interface ParseContext {
  source: ProductIdentity['source'];
  barcode?: string;
  imageUrl?: string;
  /** Cap on confidence (e.g. 0.4 when Claude only saw a barcode with no product record). */
  maxConfidence?: number;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function clamp01(v: unknown, max = 1): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(max, Math.max(0, n > 1 && n <= 100 ? n / 100 : n));
}

/** "Doritos Incógnita 62 g" → "doritos-incognita-62-g". Not the product id: that is productIdFor (gtin.ts). */
export function slugify(...parts: (string | undefined)[]): string {
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

/** Validate Claude's JSON object and turn it into a ProductIdentity. Throws IdentifyError. */
export function parseIdentity(raw: unknown, ctx: ParseContext): ProductIdentity {
  if (!raw || typeof raw !== 'object') throw new IdentifyError('Identification returned no data', 'invalid_output');
  const o = raw as Record<string, unknown>;
  const brand = str(o.brand);
  const productName = str(o.productName);
  if (!brand || !productName) throw new IdentifyError('Could not find a product in this input', 'not_a_product');

  const size = str(o.size);
  const variant = str(o.variant);
  // Alternatives that are the answer again, or repeat one another (same product slug), are dropped.
  const seen = new Set([productSlug({ brand, productName, variant, size })]);
  const alternatives = (Array.isArray(o.alternatives) ? o.alternatives : [])
    .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {}))
    .filter((a) => str(a.brand) && str(a.productName))
    .map((a) => ({
      brand: str(a.brand)!,
      productName: str(a.productName)!,
      variant: str(a.variant),
      size: str(a.size),
      confidence: clamp01(a.confidence),
    }))
    .filter((a) => {
      const key = productSlug(a);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);

  return {
    id: productIdFor({ barcode: ctx.barcode, brand, productName, variant, size }),
    brand,
    productName,
    variant,
    size,
    barcode: ctx.barcode,
    manufacturer: str(o.manufacturer),
    categoryGuess: str(o.categoryGuess),
    imageUrl: ctx.imageUrl,
    confidence: clamp01(o.confidence, ctx.maxConfidence),
    source: ctx.source,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
  };
}

/** The parts of a Messages API response we read (keeps this file SDK-free for tests). */
export interface ClaudeResponseLike {
  stop_reason: string | null;
  content: readonly { type: string; text?: string }[];
}

/** Blocks of a web search turn; text before the last one is Claude thinking aloud, not the answer. */
const TOOL_BLOCKS = new Set(['server_tool_use', 'web_search_tool_result']);

/**
 * Check stop_reason, take the answer's text (after the last web search, if any), JSON.parse it and validate.
 * Without structured output the JSON may sit inside prose or a code fence; the outermost {...} is used. Throws IdentifyError.
 */
export function parseClaudeResponse(res: ClaudeResponseLike, ctx: ParseContext): ProductIdentity {
  if (res.stop_reason === 'refusal') throw new IdentifyError('Claude declined to identify this input', 'refusal');
  if (res.stop_reason === 'max_tokens') throw new IdentifyError('Identification was cut off', 'truncated');
  if (res.stop_reason === 'pause_turn') throw new IdentifyError('Identification did not finish its web search', 'truncated');
  let lastTool = -1;
  res.content.forEach((b, i) => {
    if (TOOL_BLOCKS.has(b.type)) lastTool = i;
  });
  const text = res.content
    .slice(lastTool + 1)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      json = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new IdentifyError('Identification returned invalid JSON', 'invalid_output');
  }
  return parseIdentity(json, ctx);
}

/** Subset of an Open Food Facts v2 product. */
export interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_es?: string;
  brands?: string;
  quantity?: string;
  image_front_url?: string;
  image_url?: string;
  categories?: string;
  manufacturing_places?: string;
}

/** `GET /api/v2/product/<code>.json` body → product, or undefined when not found. */
export function parseOffResponse(body: unknown): OffProduct | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { status?: unknown; product?: unknown };
  if (b.status !== 1 || !b.product || typeof b.product !== 'object') return undefined;
  const p = b.product as OffProduct;
  return str(p.product_name_es) || str(p.product_name) ? p : undefined;
}

/** No record, or one without a brand ("choklad not"): too little to name the product without a web search. */
export function isThinRecord(p: OffProduct | undefined): boolean {
  return !p || !str(p.brands);
}

/** Fallback identity straight from Open Food Facts when Claude isn't available. */
export function identityFromOff(p: OffProduct, code: string): ProductIdentity {
  const name = str(p.product_name_es) ?? str(p.product_name);
  if (!name) throw new IdentifyError('Product not found in Open Food Facts', 'not_found');
  const brand = str(p.brands?.split(',')[0]) ?? name.split(' ')[0];
  const productName = name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
  const size = str(p.quantity);
  return {
    id: productIdFor({ barcode: code, brand, productName, size }),
    brand,
    productName,
    size,
    barcode: code,
    categoryGuess: str(p.categories?.split(',').slice(-2).join(' > ')),
    imageUrl: str(p.image_front_url) ?? str(p.image_url),
    confidence: 0.7,
    source: 'openfoodfacts',
  };
}
