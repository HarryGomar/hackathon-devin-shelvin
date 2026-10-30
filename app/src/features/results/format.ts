import type { Listing } from '@/api/types';

import { fieldLabelOverrides, strings } from './strings';

// Prices and numbers use Mexican formatting; dates follow the device locale.
const LOCALE = 'es-MX';

export function formatPrice(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(amount);
  } catch {
    // Unknown currency code from the API: still show the number.
    return `${new Intl.NumberFormat(LOCALE).format(amount)} ${currency}`;
  }
}

/** "14:05", or undefined for a missing/invalid date. */
export function formatTime(iso?: string) {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "Oct 28, 14:05" (device locale). */
export function formatDateTime(iso?: string) {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** `net_weight` → "Net weight", `reviewCount` → "Review count". */
export function humanizeKey(key: string) {
  const override = fieldLabelOverrides[key.toLowerCase()];
  if (override) return override;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const ID_KEYS = new Set(['sku', 'gtin', 'ean', 'upc', 'barcode', 'code', 'id']);

/** Keys like `sku`, `gtin`, `product_id` or `retailerId` hold identifiers, not quantities. */
export function isIdentifierKey(key: string) {
  const k = key.toLowerCase();
  return ID_KEYS.has(k) || /[_\-.](id|code)$/.test(k) || /[a-z0-9](Id|Code)$/.test(key);
}

/** Field value for display. Identifiers and long integers (8+ digits) are shown as-is, never "7,501,…". */
export function formatFieldValue(key: string, value: string | number | boolean | null) {
  if (value === null || value === '') return strings.empty;
  if (typeof value === 'boolean') return value ? strings.yes : strings.no;
  if (typeof value === 'number') {
    if (isIdentifierKey(key) || (Number.isInteger(value) && Math.abs(value) >= 1e7)) return String(value);
    return new Intl.NumberFormat(LOCALE).format(value);
  }
  return HTML_HINT.test(value) ? htmlToText(value) : value;
}

/**
 * An HTML tag by name, a comment or an entity: the field holds the page's raw HTML (scrapers keep fields as the page
 * has them). Prose like "x <y> z" isn't taken for HTML. `[^<>]*` keeps it linear on a run of unclosed '<'.
 */
const HTML_HINT =
  /<\/?(?:p|br|li|ul|ol|div|span|b|i|u|em|strong|small|sup|sub|h[1-6]|table|tbody|thead|tr|td|th|a|img|font|section|article|script|style|noscript|template)\b[^<>]*>|<!--|&(#\d+|#x[\da-f]+|[a-z]+);/i;

/** Longer fields are cut before conversion: no description needs more, and a hostile field can't stall the screen. */
const MAX_HTML_CHARS = 20_000;

/** Opening of a part the page never shows as text: a comment, or a script/style/noscript/template element. */
const HIDDEN_OPEN = /<!--|<(script|style|noscript|template)\b[^<>]*>/gi;

/**
 * The HTML without comments and script/style/noscript/template elements (contents included). One pass: each close is
 * found with indexOf, and an unclosed one hides the rest, as a browser would.
 */
function dropHidden(html: string) {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  HIDDEN_OPEN.lastIndex = 0;
  for (let m = HIDDEN_OPEN.exec(html); m; m = HIDDEN_OPEN.exec(html)) {
    out += html.slice(from, m.index);
    const element = m[1]?.toLowerCase();
    const close = lower.indexOf(element ? `</${element}` : '-->', HIDDEN_OPEN.lastIndex);
    if (close < 0) return out;
    const end = element ? html.indexOf('>', close) : close + 2;
    if (end < 0) return out;
    from = end + 1;
    HIDDEN_OPEN.lastIndex = from;
  }
  return out + html.slice(from);
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', iexcl: '¡', iquest: '¿', deg: '°',
};

/**
 * HTML from a field as plain text: comments, scripts and styles dropped with their contents, each <li> a "• " line,
 * <br> and block ends a line break, other tags dropped, entities decoded, blank lines and runs of spaces removed.
 * Fields past MAX_HTML_CHARS are cut first and end in "…".
 */
export function htmlToText(html: string) {
  const cut = html.length > MAX_HTML_CHARS;
  const text = dropHidden(cut ? html.slice(0, MAX_HTML_CHARS) : html)
    .replace(/<li\b[^<>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    })
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return cut ? `${text}…` : text;
}

/** Hostname for a failure row when we only have the URL. */
export function domainOf(url: string) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return match?.[1]?.replace(/^www\./, '');
}

/** One row per extra field, in the order the API returned them: `{ key, label: "Net weight", value: "62 g" }`. */
export function fieldRows(fields: Listing['fields'] | undefined) {
  return Object.entries(fields ?? {}).map(([key, value]) => ({ key, label: humanizeKey(key), value: formatFieldValue(key, value) }));
}

/** "GPC · Code 10000045" under the standard taxonomy breadcrumb; empty when there's nothing to add. */
export function taxonomyNote(taxonomy: Listing['standardTaxonomy']) {
  if (!taxonomy) return '';
  return [taxonomy.system, taxonomy.code ? strings.taxonomyCode(taxonomy.code) : undefined].filter(Boolean).join(' · ');
}
