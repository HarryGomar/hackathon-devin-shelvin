import { homeStrings as s } from './strings';

const BARCODE_LENGTHS = [8, 12, 13];

/** Digits only, spaces and dashes removed. Valid when 8 (EAN-8), 12 (UPC-A) or 13 (EAN-13) digits long. */
export function normalizeBarcode(raw: string): { code: string; valid: boolean } {
  const code = raw.replace(/[\s-]/g, '');
  return { code, valid: /^\d+$/.test(code) && BARCODE_LENGTHS.includes(code.length) };
}

/** "today 14:05", "yesterday 09:30", or "Oct 26, 18:00" (device locale, like Results). */
export function formatLastScraped(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return `${s.today} ${time}`;
  if (date.getTime() >= startOfToday - dayMs) return `${s.yesterday} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
