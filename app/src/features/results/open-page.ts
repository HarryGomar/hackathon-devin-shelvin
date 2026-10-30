import * as WebBrowser from 'expo-web-browser';

import type { Listing } from '@/api/types';

/** Opens a web page in the in-app browser (a store page, a builder session, a pull request). */
export function openPage(url: string) {
  WebBrowser.openBrowserAsync(url).catch(() => {});
}

export function openListingPage(listing: Listing) {
  openPage(listing.url);
}
