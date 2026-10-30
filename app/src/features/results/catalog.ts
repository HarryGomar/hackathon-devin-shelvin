import type { BrandCatalog, Listing } from '@/api/types';

import { shownPrice } from './compare';

/**
 * The row of a brand's catalog that is the scanned product: the catalog row with the same address and title as the
 * listing the scrape matched on that page (else the same title). -1 when the scrape matched none.
 */
export function catalogMatchIndex(catalog: BrandCatalog, listings: Listing[]): number {
  const matched = listings.find((l) => l.pageId === catalog.pageId);
  if (!matched) return -1;
  const same = catalog.listings.findIndex((l) => l.url === matched.url && l.title === matched.title);
  if (same >= 0) return same;
  return matched.title ? catalog.listings.findIndex((l) => l.title === matched.title) : -1;
}

/** The rows to show: the first `limit`, plus the scanned product's row when it is further down. */
export function catalogVisibleRows(catalog: BrandCatalog, match: number, limit: number, showAll: boolean): { listing: Listing; index: number }[] {
  const rows = catalog.listings.map((listing, index) => ({ listing, index }));
  if (showAll || rows.length <= limit) return rows;
  const head = rows.slice(0, limit);
  return match >= limit ? [...head, rows[match]] : head;
}

/**
 * The currency of the catalog's price column: from the first row with a price to show (shownPrice, so an out-of-stock
 * row's placeholder doesn't count). Undefined when no row has one: some brand sites list no prices, and the column goes.
 */
export function catalogPriceCurrency(catalog: BrandCatalog): string | undefined {
  for (const listing of catalog.listings) {
    const price = shownPrice(listing);
    if (price) return price.currency;
  }
  return undefined;
}
