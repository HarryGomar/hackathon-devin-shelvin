import type { ProductIdentity } from '../../../app/src/api/types.ts';
import type { OffProduct } from '../../../app/src/services/identify/parse.ts';
import type { CallRecord } from './claude.ts';

export type { OffProduct, ProductIdentity };

/** One product in testset.json. */
export interface TestItem {
  barcode: string;
  /** 'big' = national brand (Sabritas, Barcel, Bimbo, Coca-Cola, Lala, Nestlé, Gamesa …); 'small' = the rest. */
  tier: 'big' | 'small';
  /** Supermarket aisle, for reading the tables. */
  aisle: string;
  /** The Open Food Facts record as the app receives it (same `fields=`, parseOffResponse); absent when OFF has none. */
  off?: OffProduct;
  /** full = brand, name and quantity; thin = a record without a brand or quantity; none = no record. */
  offStatus: 'full' | 'thin' | 'none';
  /** Hard cases this product stands for: thin-off, no-off, same-line-sizes, same-line-flavors, upc-a, store-brand, import. */
  tricky?: string[];
  /** Time the uncached OFF lookup took when the test set was built. */
  offLatencyMs: number;
  /** Front photo (display size) and its original, which arm D downscales like the app does. */
  imageUrl?: string;
  imageFullUrl?: string;
  /** A photo that shows the printed barcode (arm E). */
  barcodeImageUrl?: string;
}

/** One entry in answers.json: what the product really is, from the OFF record and checked against the photo. */
export interface Answer {
  barcode: string;
  brand: string;
  /** Other brand strings that are also printed on the pack and count as correct (e.g. "Sabritas" on Doritos). */
  brandAliases?: string[];
  /** Full name including brand, as on the pack. */
  productName: string;
  nameAliases?: string[];
  /** Flavor/variant; "" when the product has none. */
  variant: string;
  /** Other ways of writing the variant that also count (a translation of an English-only label, say). */
  variantAliases?: string[];
  /**
   * The variant is the plain/default one ("Original", "Natural"), so an answer that names no variant is also
   * correct, as long as it doesn't name a different one.
   */
  variantOptional?: boolean;
  /** Net content with unit, as printed, e.g. "62 g". */
  size: string;
  /** Other sizes printed on the pack that also count, e.g. "245 g" next to "250 ml". */
  sizeAliases?: string[];
  /**
   * How readable the OFF front photo is for arm D. 'no-label' photos are excluded from arm D's accuracy
   * (nothing to read), but a confident answer on one still counts as confident-wrong.
   */
  photo: 'good' | 'poor' | 'no-label';
  /** What was checked, and anything corrected relative to the OFF record. */
  checkNote: string;
  /** Fields changed from the OFF record after looking at the photo. */
  corrected?: ('brand' | 'productName' | 'variant' | 'size')[];
  /** Record and photo disagree and the key is a judgment call. */
  uncertain?: boolean;
}

export type ArmId = 'A' | 'B' | 'C' | 'D' | 'E';

export const ARMS: Record<ArmId, string> = {
  A: 'OFF only (identityFromOff)',
  B: 'Barcode, app flow (OFF → Claude; web search when the record is thin or missing)',
  C: 'Barcode with the OFF record hidden (app flow: web search)',
  D: 'Photo of the front, app flow',
  E: 'Photo showing the barcode, app flow',
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
}

export interface Score {
  brand: boolean;
  name: boolean;
  /** Dice overlap of normalized name tokens, 0..1. */
  nameOverlap: number;
  /** null when the answer has no variant. */
  variant: boolean | null;
  size: boolean;
  /** Brand, name, size and (when the answer has one) variant all match. */
  all: boolean;
  /** Wrong overall while the app would show confidence ≥ 0.8. */
  confidentWrong: boolean;
}

export interface ArmResult {
  arm: ArmId;
  barcode: string;
  status: 'ok' | 'error' | 'skipped';
  /** IdentifyError code, API error class, or why it was skipped. */
  error?: string;
  identity?: ProductIdentity;
  /** End to end: from the scan (or the prepared photo) to the identity, OFF and the photo step included. */
  latencyMs?: number;
  /** The Claude calls the pipeline made. */
  calls?: CallRecord[];
  costUsd?: number;
  /** Claude failed and, like the app, the OFF identity was used instead. */
  fellBackToOff?: boolean;
  score?: Score;
}
