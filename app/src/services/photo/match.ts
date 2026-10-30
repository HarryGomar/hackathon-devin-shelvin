/**
 * Pure parsing, matching and priority for product photos. No runtime imports, so it runs under
 * `node --test` (see match.test.ts) as well as in the app.
 */
import type { ProductIdentity } from '@/api/types';

/** One product from `GET /api/v2/search` (only the fields we ask for). */
export interface OffSearchHit {
  code?: string;
  product_name?: string;
  product_name_es?: string;
  brands?: string;
  quantity?: string;
  image_front_url?: string;
}

/** What we know about the product we want a photo of. */
export type PhotoTarget = Pick<ProductIdentity, 'brand' | 'productName' | 'variant' | 'size' | 'manufacturer'>;

export type ImageSource = NonNullable<ProductIdentity['imageSource']>;

/**
 * Search response body → hits; anything else (rate-limit page, error JSON) → []. Reads both `api/v2/search`
 * (`products`, brands as a string) and search.openfoodfacts.org (`hits`, brands as a list).
 */
export function parseOffSearch(body: unknown): OffSearchHit[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as { products?: unknown; hits?: unknown };
  const list = Array.isArray(b.products) ? b.products : Array.isArray(b.hits) ? b.hits : [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({ ...p, brands: Array.isArray(p.brands) ? p.brands.join(', ') : p.brands }) as OffSearchHit);
}

/** Words that say nothing about which product it is. */
const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'y', 'en', 'a', 'al', 'sabor', 'botana', 'botanas', 'the', 'and', 'with',
  'g', 'gr', 'grs', 'gramos', 'kg', 'ml', 'l', 'lt', 'oz', 'pz', 'pza', 'piezas', 'paquete', 'bolsa', 'mexico', 'original',
  'unidad', 'unidades', 'pieza', 'empaque', 'tipo',
]);

/** Words that name a flavor or a version: one the target doesn't have means a different product. */
const FLAVOR_WORDS = new Set([
  'queso', 'chile', 'limon', 'fuego', 'picante', 'nacho', 'salsa', 'verde', 'roja', 'dinamita', 'flamin', 'flaming', 'hot',
  'xtra', 'extra', 'habanero', 'jalapeno', 'chipotle', 'bbq', 'ranch', 'crema', 'cebolla', 'sal', 'pimienta', 'mango',
  'tamarindo', 'incognita', 'pizzerola', 'pizza', 'adobado', 'adobadas', 'chamoy', 'enchilado', 'enchiladas', 'mantequilla',
  'light', 'zero', 'fresa', 'chocolate', 'vainilla', 'naranja', 'blue', 'black', 'gran', 'malo', 'intense', 'mix',
]);

/** Extra (non-flavor) words a hit may have beyond the target, for OFF's noisy names ("ADN … unidades"). */
const MAX_EXTRA = 2;

/** "Doritos® Flamin’ Hot 62 g" → ["doritos", "flamin", "hot"]. */
export function tokens(text: string | undefined): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+(\.\d+)?$/.test(t));
}

/** Same word, allowing a plural or a cut ("nacho" / "nachos"). */
function sameWord(a: string, b: string) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
}

const has = (words: string[], w: string) => words.some((x) => sameWord(x, w));

/** "61 gr" / "0.5 kg" / "600ml" → grams or millilitres; undefined when unreadable. */
export function sizeAmount(size: string | undefined): number | undefined {
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|kilo|g|gr|grs|gramos|ml|l|lt|litro)s?\b/i.exec(size ?? '');
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  return unit === 'kg' || unit === 'kilo' || unit === 'l' || unit === 'lt' || unit === 'litro' ? n * 1000 : n;
}

function brandWords(target: PhotoTarget) {
  const maker = (target.manufacturer ?? '').split(/[()]/);
  return [...tokens(target.brand), ...maker.flatMap((m) => tokens(m))];
}

/**
 * How well a hit matches (higher is better), or undefined when it doesn't. It needs an https front image, the brand
 * itself, and every distinctive word of the name and flavor; a flavor word the target lacks, or more than
 * `MAX_EXTRA` other extra words, rule it out. Fewer extra words always rank higher; the same size only breaks ties.
 */
export function scoreHit(target: PhotoTarget, hit: OffSearchHit): number | undefined {
  if (!hit.image_front_url || !/^https:\/\//.test(hit.image_front_url)) return undefined;
  const brand = tokens(target.brand);
  const makers = brandWords(target);
  const name = tokens(hit.product_name_es || hit.product_name);
  const all = [...name, ...tokens(hit.product_name), ...tokens(hit.brands)];
  // The brand itself, not just the maker: Sabritas also makes Cheetos.
  if (brand.length === 0 || !brand.every((w) => has(all, w))) return undefined;

  const key = [...new Set([...tokens(target.productName), ...tokens(target.variant)])].filter((w) => !has(makers, w));
  // Only the brand is known ("Doritos"): any Doritos photo would be a guess.
  if (key.length === 0 || !key.every((w) => has(all, w))) return undefined;

  const extras = name.filter((w) => !has(key, w) && !has(makers, w));
  if (extras.some((w) => [...FLAVOR_WORDS].some((f) => sameWord(f, w))) || extras.length > MAX_EXTRA) return undefined;
  const want = sizeAmount(target.size);
  const got = sizeAmount(hit.quantity);
  const sameSize = want !== undefined && got !== undefined && Math.abs(want - got) <= Math.max(2, want * 0.05);
  return -extras.length + (sameSize ? 0.5 : 0);
}

/** The best-matching hit's front image, or undefined. Ties keep OFF's order (most scanned first). */
export function bestImage(target: PhotoTarget, hits: readonly OffSearchHit[]): string | undefined {
  let best: { score: number; url: string } | undefined;
  for (const hit of hits) {
    const score = scoreHit(target, hit);
    if (score !== undefined && (!best || score > best.score)) best = { score, url: hit.image_front_url! };
  }
  return best?.url;
}

/** Brand tags to search, most specific first: "Doritos" / "Sabritas (PepsiCo México)" → doritos, sabritas, pepsico. */
export function searchBrandTags(target: PhotoTarget): string[] {
  const names = [target.brand, ...(target.manufacturer ?? '').split(/[()]/)];
  const tags = names
    .map((n) => n.replace(/\b(m[eé]xico|grupo|s\.?a\.?(\s*de\s*c\.?v\.?)?)\b/gi, '').trim())
    .map((n) =>
      n
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
    )
    .filter((t) => t.length > 1);
  return [...new Set(tags)].slice(0, 2);
}

export interface PhotoCandidates {
  /** The front image of the exact barcode's Open Food Facts record. */
  offExact?: string;
  /** The best match from an Open Food Facts search. */
  offSearch?: string;
  /** The user's own photo of the pack. */
  userPhoto?: string;
}

/** Priority: OFF exact barcode → OFF search → the user's photo → none. */
export function pickImage(c: PhotoCandidates): { imageUrl?: string; imageSource?: ImageSource } {
  if (c.offExact) return { imageUrl: c.offExact, imageSource: 'openfoodfacts' };
  if (c.offSearch) return { imageUrl: c.offSearch, imageSource: 'openfoodfacts' };
  if (c.userPhoto) return { imageUrl: c.userPhoto, imageSource: 'user_photo' };
  return {};
}
