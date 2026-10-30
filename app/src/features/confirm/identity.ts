import type { ProductIdentity, ScanInput } from '@/api/types';
import { normalizeGtin, productIdFor } from '@/services/identify/gtin';
import type { Tone } from '@/theme';

import { strings } from './strings';

export type Alternative = NonNullable<ProductIdentity['alternatives']>[number];

/** Editable text fields of an identity. */
export interface IdentityDraft {
  brand: string;
  productName: string;
  variant: string;
  size: string;
  barcode: string;
  manufacturer: string;
}

export function confidenceBadge(confidence: number): { label: string; tone: Tone } {
  if (confidence >= 0.8) return { label: strings.confidence.high, tone: 'success' };
  if (confidence >= 0.5) return { label: strings.confidence.check, tone: 'warning' };
  return { label: strings.confidence.low, tone: 'danger' };
}

/** Barcode digits from the scan, if the input was a barcode. */
export function inputBarcode(input?: ScanInput) {
  return input && input.kind !== 'photo' ? input.code : undefined;
}

/**
 * The user picked an alternative: it becomes the identity, and the previous guess
 * takes its place in the list so they can switch back.
 */
export function identityFromAlternative(current: ProductIdentity, alt: Alternative, input?: ScanInput): ProductIdentity {
  const sameBrand = alt.brand === current.brand;
  const previous: Alternative = {
    brand: current.brand,
    productName: current.productName,
    variant: current.variant,
    size: current.size,
    confidence: current.confidence,
  };
  const barcode = inputBarcode(input);
  return {
    // A scanned barcode keeps its gtin- id (it's still the product in hand); without one, the slug includes the size.
    id: productIdFor({ barcode, brand: alt.brand, productName: alt.productName, variant: alt.variant, size: alt.size }),
    brand: alt.brand,
    productName: alt.productName,
    variant: alt.variant,
    size: alt.size,
    barcode,
    manufacturer: sameBrand ? current.manufacturer : undefined,
    categoryGuess: current.categoryGuess,
    confidence: 1,
    source: 'user_edited',
    alternatives: (current.alternatives ?? []).map((a) => (a === alt ? previous : a)),
  };
}

export function draftFrom(identity?: ProductIdentity, input?: ScanInput): IdentityDraft {
  return {
    brand: identity?.brand ?? '',
    productName: identity?.productName ?? '',
    variant: identity?.variant ?? '',
    size: identity?.size ?? '',
    barcode: identity?.barcode ?? inputBarcode(input) ?? '',
    manufacturer: identity?.manufacturer ?? '',
  };
}

const plainWords = (s: string | undefined) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const wordsOf = (...parts: (string | undefined)[]) => new Set(parts.flatMap(plainWords));
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));

/**
 * The answer in another size: same brand, and the name + flavor words of one contain the other's (Claude sometimes adds
 * a word, like "Chile Limón (Sabritas México)").
 */
export function isOtherSize(identity: Pick<ProductIdentity, 'brand' | 'productName' | 'variant' | 'size'>, alt: Alternative) {
  if (!alt.size || plainWords(alt.size).join(' ') === plainWords(identity.size).join(' ')) return false;
  if (plainWords(alt.brand).join(' ') !== plainWords(identity.brand).join(' ')) return false;
  const a = wordsOf(identity.productName, identity.variant);
  const b = wordsOf(alt.productName, alt.variant);
  return isSubset(a, b) || isSubset(b, a);
}

/** Alternatives split into other sizes of the answer (a size picker) and other products ("Not quite?"). */
export function splitAlternatives(identity: ProductIdentity): { sizes: Alternative[]; others: Alternative[] } {
  const all = identity.alternatives ?? [];
  return { sizes: all.filter((a) => isOtherSize(identity, a)), others: all.filter((a) => !isOtherSize(identity, a)) };
}

/**
 * How likely it is that this is the product, whatever its size: Claude's confidence covers the exact size, so the
 * other sizes it listed add theirs. The size itself is checked with the size picker.
 */
export function productConfidence(identity: ProductIdentity) {
  const sizes = splitAlternatives(identity).sizes.reduce((sum, a) => sum + a.confidence, 0);
  return Math.min(1, identity.confidence + sizes);
}

/**
 * An alternative's row text. The flavor/variant goes in the title unless the name already says it, so lines of the
 * same product ("IKEA Choklad" milk vs dark) don't look identical; brand and size go underneath.
 */
export function alternativeLabel(alt: Alternative): { title: string; subtitle: string } {
  const name = new Set(plainWords(alt.productName));
  const variantNew = plainWords(alt.variant).some((w) => !name.has(w));
  const title = variantNew ? `${alt.productName} · ${alt.variant}` : alt.productName;
  const brandInName = plainWords(alt.brand).every((w) => name.has(w));
  return { title, subtitle: [brandInName ? undefined : alt.brand, alt.size].filter(Boolean).join(' · ') };
}

export function isDraftValid(draft: IdentityDraft) {
  return draft.brand.trim() !== '' && draft.productName.trim() !== '';
}

export function identityFromDraft(draft: IdentityDraft, base?: ProductIdentity): ProductIdentity {
  const clean = (s: string) => s.trim() || undefined;
  const brand = draft.brand.trim();
  const productName = draft.productName.trim();
  const variant = clean(draft.variant);
  const size = clean(draft.size);
  const barcode = clean(draft.barcode);
  // Same barcode → same product → same id, whatever was edited; otherwise gtin- of the new barcode, or the slug.
  const gtin = normalizeGtin(barcode);
  const id = base && gtin && gtin === normalizeGtin(base.barcode) ? base.id : productIdFor({ barcode, brand, productName, variant, size });
  // Keep the image and category only while it's still the same product.
  const kept = base?.id === id ? base : { alternatives: base?.alternatives };
  return {
    ...kept,
    id,
    brand,
    productName,
    variant,
    size,
    barcode,
    manufacturer: clean(draft.manufacturer),
    confidence: 1,
    source: 'user_edited',
  };
}
