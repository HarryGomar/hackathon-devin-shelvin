/**
 * Scoring an identity against the answer key. Text is compared after normalizing (lowercase, no accents, no
 * punctuation, a few Spanish stopwords dropped, plural "s" stripped); sizes are compared as numbers in g or ml.
 */
import type { Answer, ProductIdentity, Score } from './types.ts';

/** Probability at or above which a wrong answer counts as "confidently wrong". */
export const CONFIDENT = 0.8;
/** Minimum Dice overlap of name tokens for a name match. */
export const NAME_OVERLAP = 0.8;

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'con', 'y', 'en', 'a', 'sabor', 'the', 'and']);
const UNIT_WORDS = new Set(['g', 'gr', 'grs', 'gramos', 'kg', 'ml', 'l', 'lt', 'lts', 'litro', 'litros', 'cont', 'net']);

export function normalize(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();
}

/** Name tokens: normalized words without stopwords, sizes or unit words; "nachos" → "nacho". */
export function tokens(s: string | undefined): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t) && !UNIT_WORDS.has(t) && !/^\d+([.,]\d+)?$/.test(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Dice coefficient of two token sets, 0..1. */
export function overlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return (2 * common) / (A.size + B.size);
}

const squash = (s: string | undefined) => normalize(s).replace(/ /g, '');

export function brandMatches(pred: string | undefined, answer: Answer): boolean {
  const p = squash(pred);
  return p.length > 0 && [answer.brand, ...(answer.brandAliases ?? [])].some((b) => squash(b) === p);
}

export function nameOverlap(pred: string | undefined, answer: Answer): number {
  const p = tokens(pred);
  return Math.max(...[answer.productName, ...(answer.nameAliases ?? [])].map((n) => overlap(p, tokens(n))));
}

/**
 * The answer's variant words all appear in the predicted variant or name. For a default variant
 * ("Original"), also correct when the prediction adds no words beyond the answer's brand and name.
 */
export function variantMatches(pred: Pick<ProductIdentity, 'variant' | 'productName' | 'brand'>, answer: Answer): boolean | null {
  if (!answer.variant) return null;
  const have = new Set(tokens(`${pred.variant ?? ''} ${pred.productName}`));
  if ([answer.variant, ...(answer.variantAliases ?? [])].some((v) => tokens(v).every((t) => have.has(t)))) return true;
  if (!answer.variantOptional) return false;
  const known = new Set(tokens([answer.brand, ...(answer.brandAliases ?? []), answer.productName, ...(answer.nameAliases ?? [])].join(' ')));
  return [...have].every((t) => known.has(t));
}

type Unit = 'g' | 'ml';
const UNITS: Record<string, [Unit, number]> = {
  g: ['g', 1], gr: ['g', 1], grs: ['g', 1], gms: ['g', 1], gramo: ['g', 1], gramos: ['g', 1],
  kg: ['g', 1000], kgs: ['g', 1000], kilo: ['g', 1000], kilos: ['g', 1000], kilogramo: ['g', 1000], kilogramos: ['g', 1000],
  ml: ['ml', 1], mililitro: ['ml', 1], mililitros: ['ml', 1], cl: ['ml', 10],
  l: ['ml', 1000], lt: ['ml', 1000], lts: ['ml', 1000], litro: ['ml', 1000], litros: ['ml', 1000],
};

export interface Amount {
  value: number;
  unit: Unit;
}

function num(s: string): number {
  // "1,000" is a thousands separator; "2,5" is a decimal comma.
  return Number(/^\d{1,3},\d{3}$/.test(s) ? s.replace(',', '') : s.replace(',', '.'));
}

/** Every amount in a size string: "62 g", "62g", "62 gr", "1.8L", "2,5 l", "360 g (339.9 ml)", "3 x 50 g" (→ 150 g). */
export function parseSizes(s: string | undefined): Amount[] {
  const text = (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[×*]/g, 'x');
  const out: Amount[] = [];
  const multi = /(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)\b/g;
  for (const m of text.matchAll(multi)) {
    const u = UNITS[m[3]!];
    if (u) out.push({ value: Number(m[1]) * num(m[2]!) * u[1], unit: u[0] });
  }
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z]+)\b/g)) {
    const u = UNITS[m[2]!];
    if (u) out.push({ value: num(m[1]!) * u[1], unit: u[0] });
  }
  return out;
}

/** Any amount in the prediction equals (within 1%) the answer's size or one of its aliases. */
export function sizeMatches(pred: string | undefined, answer: Answer): boolean {
  const want = [answer.size, ...(answer.sizeAliases ?? [])].flatMap(parseSizes);
  return parseSizes(pred).some((p) => want.some((w) => w.unit === p.unit && Math.abs(w.value - p.value) <= w.value * 0.01));
}

export function scoreIdentity(id: ProductIdentity, answer: Answer): Score {
  const brand = brandMatches(id.brand, answer);
  const nameOv = nameOverlap(id.productName, answer);
  const name = nameOv >= NAME_OVERLAP;
  const variant = variantMatches(id, answer);
  const size = sizeMatches(id.size, answer);
  const all = brand && name && size && variant !== false;
  return { brand, name, nameOverlap: Math.round(nameOv * 100) / 100, variant, size, all, confidentWrong: !all && id.confidence >= CONFIDENT };
}
