import type { Listing } from '@/api/types';

/** The listing with this id in the first list that has it (e.g. the current scrape, then the saved listings). */
export function findListing(id: string, ...lists: (readonly Listing[] | undefined)[]): Listing | undefined {
  for (const list of lists) {
    const found = list?.find((l) => l.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Page ids of the saved listings, once each. */
export function savedPageIds(listings: readonly Listing[]) {
  return [...new Set(listings.map((l) => l.pageId))];
}
