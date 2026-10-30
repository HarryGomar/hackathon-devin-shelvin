// Pure parts of RetailerLogo, kept apart so `npm test` can load them.

/**
 * Registrable domains of Mexican retailers whose site icon we trust. Anything else (a brand's own site, an unknown shop)
 * gets a monogram: those domains can redirect to social media or not exist, and the favicon service then returns
 * someone else's logo (takis.com.mx came back as Facebook's "f").
 */
export const KNOWN_RETAILER_DOMAINS = [
  'walmart.com.mx',
  'bodegaaurrera.com.mx',
  'soriana.com',
  'chedraui.com.mx',
  'lacomer.com.mx',
  'heb.com.mx',
  'amazon.com.mx',
  'mercadolibre.com.mx',
  'sams.com.mx',
  'costco.com.mx',
  'oxxo.com',
  '7-eleven.com.mx',
] as const;

/** `super.walmart.com.mx` → `walmart.com.mx`; undefined unless the host is a known retailer or one of its subdomains. */
export function knownRetailerDomain(host: string) {
  const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return KNOWN_RETAILER_DOMAINS.find((d) => h === d || h.endsWith(`.${d}`));
}

/** Site icon for a known retailer, served at 128 px by Google's favicon service; undefined for every other domain. */
export function retailerIconUrl(host: string) {
  const domain = knownRetailerDomain(host);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : undefined;
}

/** "Walmart Súper" → "WS", "Soriana" → "S", "Takis (official site)" → "T". */
export function monogram(name: string) {
  return name
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/** A muted tint that stays the same for a domain, so retailers are told apart even without their icon. */
export function monogramColors(domain: string, dark: boolean) {
  let hash = 0;
  for (const ch of domain.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return dark
    ? { bg: `hsl(${hue}, 22%, 24%)`, fg: `hsl(${hue}, 32%, 80%)` }
    : { bg: `hsl(${hue}, 30%, 90%)`, fg: `hsl(${hue}, 32%, 30%)` };
}
