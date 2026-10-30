/**
 * Barcodes (GTINs) and product ids. Pure, no runtime imports: runs under `node --test` (gtin.test.ts), in the app,
 * and in tools/identify-benchmark.
 *
 * Product id rule (the backend uses the same one; keep the format exactly):
 * - with a valid barcode: `gtin-` + the GTIN-14, e.g. 7315122013887, 07315122013887 and 007315122013887 all give
 *   `gtin-07315122013887`; a UPC-A (12 digits) and an EAN-8 are left-padded with zeros to 14;
 * - without one (a photo with no readable barcode): a stable slug of brand + name + size, e.g. `ikea-choklad-not-100g`.
 */

export type GtinFormat = 'EAN-8' | 'UPC-A' | 'EAN-13' | 'GTIN-14';

const FORMAT_BY_LENGTH: Record<number, GtinFormat> = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' };

/** GS1 check digit for the digits before it (weights 3,1,3,… from the right). */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True for 8, 12, 13 or 14 digits whose last digit is the right GS1 check digit. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits) || !FORMAT_BY_LENGTH[digits.length]) return false;
  return gtinCheckDigit(digits.slice(0, -1)) === Number(digits[digits.length - 1]);
}

/** Digits only, without extra leading zeros beyond 14 ("007315122013887" → "07315122013887"). */
function cleanDigits(code: string): string {
  let d = code.replace(/\D/g, '');
  while (d.length > 14 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/**
 * The GTIN-14 of a scanned or typed code (digits only, check digit validated, left-padded with zeros), or undefined
 * when it isn't a valid EAN-8 / UPC-A / EAN-13 / GTIN-14. An EAN-8 stays an EAN-8: "75007614" → "00000075007614".
 */
export function normalizeGtin(code: string | undefined): string | undefined {
  const d = cleanDigits(code ?? '');
  if (isValidGtin(d)) return d.padStart(14, '0');
  return undefined;
}

export interface BarcodeInfo {
  /** Digits as scanned (non-digits removed). */
  digits: string;
  format?: GtinFormat;
  /** The GS1 check digit is right. A wrong one usually means a misread or mistyped digit. */
  checkDigitValid: boolean;
  gtin14?: string;
}

export function describeBarcode(code: string): BarcodeInfo {
  const digits = cleanDigits(code);
  const checkDigitValid = isValidGtin(digits);
  return { digits, format: FORMAT_BY_LENGTH[digits.length], checkDigitValid, gtin14: checkDigitValid ? digits.padStart(14, '0') : undefined };
}

/**
 * Codes to try against Open Food Facts, most likely first: the code as scanned, then the same GTIN written as
 * EAN-13 (a UPC-A with a leading 0, as iOS reports it) and as UPC-A (an EAN-13 starting with 0, as Android reports
 * it), and a GTIN-14 cut to 13. Only codes with a valid check digit get variants; an invalid one is tried as is.
 */
export function lookupCandidates(code: string): string[] {
  const digits = cleanDigits(code);
  const gtin = normalizeGtin(digits);
  if (!gtin) return digits ? [digits] : [];
  const out = [digits];
  const ean13 = gtin.slice(1); // valid whenever the GTIN-14 starts with 0 (indicator digit 0)
  if (gtin.startsWith('0')) out.push(ean13);
  if (gtin.startsWith('00') && digits.length !== 8) out.push(gtin.slice(2)); // UPC-A
  return [...new Set(out)];
}

// ── Stable slug for products without a barcode ─────────────────────────────

/** "Choklad Nöt®" → ["choklad", "not"]. */
function words(text: string | undefined): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const UNIT: Record<string, string> = {
  g: 'g', gr: 'g', grs: 'g', gm: 'g', gms: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  mg: 'mg',
  ml: 'ml', mililitro: 'ml', mililitros: 'ml', cl: 'cl',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  oz: 'oz', floz: 'floz', lb: 'lb', lbs: 'lb',
  pz: 'pz', pza: 'pz', pzas: 'pz', piezas: 'pz', pieza: 'pz',
};

/** "100 g" = "100g" = "100 gr" = "100 GRS" → "100g"; "1,5 L" → "1-5l". Unreadable sizes become plain words. */
export function sizeKey(size: string | undefined): string {
  const text = (size ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const m = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|[a-z]+)\.?/.exec(text);
  if (m) {
    const unit = UNIT[m[2]!.replace(/[.\s]/g, '')];
    if (unit) return `${m[1]!.replace(/[.,]0+$/, '').replace(/[.,]/, '-')}${unit}`;
  }
  return words(text).join('-');
}

/**
 * Stable id for a product without a barcode: brand + name (+ variant words the name lacks) + size, normalized, so
 * "IKEA" + "Choklad Nöt" and "IKEA" + "IKEA CHOKLAD NÖT" give the same id.
 */
export function productSlug(p: { brand?: string; productName?: string; variant?: string; size?: string }): string {
  const brand = words(p.brand);
  let name = words(p.productName);
  const startsWithBrand = brand.length > 0 && brand.every((w, i) => name[i] === w);
  if (startsWithBrand) name = name.slice(brand.length);
  const variant = words(p.variant).filter((w) => !name.includes(w) && !brand.includes(w));
  const size = sizeKey(p.size);
  return [...brand, ...name, ...variant, size].filter(Boolean).join('-') || 'product';
}

/** The product id: `gtin-<GTIN-14>` when the barcode is valid, else the stable slug. */
export function productIdFor(p: { barcode?: string; brand?: string; productName?: string; variant?: string; size?: string }): string {
  const gtin = normalizeGtin(p.barcode);
  return gtin ? `gtin-${gtin}` : productSlug(p);
}
