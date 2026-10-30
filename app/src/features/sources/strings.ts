import type { ScanType } from '@/api/types';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export const strings = {
  // Search progress
  searchTitle: 'Finding pages',
  searchSteps: {
    search: 'Searching the web',
    verify: 'Checking each page',
    rank: 'Ranking official pages and retailers',
    scrapers: 'Looking up scrapers',
  },
  scrapersMessage: 'Checking which sites already have a scraper',
  searchFailed: 'The search failed.',
  matchFailed: 'Could not look up scrapers.',

  // Header
  demoPages: 'Demo pages',
  demoPagesMessage: 'Sample stores from the demo data, not a real web search. Add an API key in app/.env for live search.',
  scanType: {
    first_party: 'First party',
    third_party: 'Third party',
    both: 'First + third party',
  } satisfies Record<ScanType, string>,
  similarOn: 'Similar: on',
  similarOff: 'Similar: off',
  pagesFound: (n: number) => (n === 1 ? '1 page found' : `${n} pages found`),

  // Sections
  official: 'Official',
  retailers: 'Retailers',
  similar: 'Similar products',
  similarHint: 'Tap one to search for it instead.',
  similarPages: (name: string) => `Similar · ${name}`,
  groupCount: (label: string, n: number) => `${label} · ${n}`,
  matchColumn: 'Match',
  statusColumn: 'Status',
  stats: { found: 'found', verified: 'verified', unsure: 'unsure', rejected: 'rejected' },
  sameBrand: 'Same brand',
  competitor: 'Competitor',
  noPagesInSection: 'No pages found here.',
  rejected: (n: number) => `Rejected · ${n}`,
  rejectedHint: 'These pages are not the same product, so they can’t be scraped.',
  addPage: '+ Add a page',

  // Page row
  verified: 'Verified',
  unsure: 'Unsure',
  userAdded: 'Added',
  rejectedBadge: 'Rejected',
  percent: (c: number) => `${Math.round(c * 100)}%`,
  buildScraper: 'Build scraper',
  buildingScraper: 'Building scraper…',
  retryBuild: 'Try building again',
  scraperFailed: 'Scraper build failed',
  scrapedLine: 'scraped ✓ · saved listings',
  noScraper: 'no scraper yet ·',
  buildShort: 'build',
  retryBuildShort: 'retry',
  /** Opens the running build's recording (Build screen). */
  traceShort: 'trace',
  selectPage: (retailer: string) => `Scrape ${retailer}`,
  /** "BLOCKED · this site blocks AI agents": the site refuses collection; nothing to build or retry. */
  blockedLine: (reason: string) => `BLOCKED · ${lowerFirst(reason)}`,
  /** A refusal that isn't the site saying no (robots.txt couldn't be reached). */
  notCollectedLine: (reason: string) => `NOT COLLECTED · ${lowerFirst(reason)}`,
  blockedA11y: (retailer: string, reason: string) => `${retailer} is not collected: ${reason}`,
  insteadLine: (alternative: string) => `instead: ${alternative}`,

  // Footer
  scrapeN: (n: number) => (n === 1 ? 'Scrape 1 page' : `Scrape ${n} pages`),
  scrapeNone: 'Select pages to scrape',
  scrapeCount: (n: number, total: number) => `${n} / ${total}`,
  scrapingTitle: 'Scraping pages',
  scrapeSteps: {
    scrape: 'Scraping the pages',
    taxonomy: 'Mapping categories',
    save: 'Saving listings',
  },
  scrapeFailed: 'Scraping failed.',

  // No product
  noProductTitle: 'No product selected',
  noProductMessage: 'Scan or photograph a product first, then come back here.',
  backHome: 'Back to Home',

  // Add a page
  addTitle: 'Add a page',
  addIntro: 'Paste the address of a product page. We’ll build a scraper for that site so it can be included.',
  urlLabel: 'Page URL',
  urlPlaceholder: 'https://www.example.com.mx/producto',
  urlInvalid: 'Enter a full address starting with http:// or https://',
  /** The backend's build job keys: check the site, build, gate, merge. */
  buildSteps: {
    probe: 'Checking the site',
    build: 'Building the scraper',
    gate: 'Testing it on the page',
    merge: 'Making it live',
  },
  buildStepsShort: { probe: 'Probe', build: 'Build', gate: 'Gate', merge: 'Merge' },
  /** The live build panel. */
  build: {
    title: (domain: string) => `Build · ${domain}`,
    agent: 'Agent',
    demoSuffix: ' (demo)',
    attempt: 'Attempt',
    source: 'Source',
    cost: 'Cost',
    sentBack: 'report sent back',
    session: (who: string) => `${who} session`,
    pr: 'Pull request',
  },
  /** A finished build that failed, on its row: "↳ build needs a person · the gate failed 3 attempts…". */
  buildEndedLine: (word: string, note: string) => `build ${word.toLowerCase()} · ${note.charAt(0).toLowerCase()}${note.slice(1)}`,
  details: 'details',
  hideDetails: 'hide',

  // Build all missing
  missingScrapers: (n: number) => `Missing scrapers · ${n}`,
  buildAllHint: (n: number, parallel?: number) =>
    `${n === 1 ? '1 site has' : `${n} sites have`} no scraper yet. An agent builds each one, tests it against the gate and fixes it until it passes${parallel ? ` (${parallel} at a time)` : ''}.`,
  buildAll: (n: number) => (n === 1 ? 'Build the missing scraper' : `Build all ${n} missing`),
  buildAllStarted: (n: number, parallel: number) => `${n === 1 ? '1 build' : `${n} builds`} started · ${parallel} run at a time`,
  buildAllFailed: 'Could not start the builds.',
  skippedTitle: (n: number) => `Skipped · ${n}`,
  pagesCount: (n: number) => `${n} pages`,
  buildsRunning: (n: number) => (n === 1 ? '1 build running' : `${n} builds running`),

  // Scrape progress per site
  sitesTitle: 'Sites',
  siteRows: (n: number) => (n === 1 ? '1 row' : `${n} rows`),
  buildFailed: 'Could not build a scraper.',
  buildBlocked: (reason: string) => `Blocked by the site: ${lowerFirst(reason)}. No scraper is built for it.`,
  /** A refusal that isn't the site saying no (robots.txt couldn't be reached), as Pages found's NOT COLLECTED. */
  buildNotCollected: (reason: string) => `Not collected: ${lowerFirst(reason)}. No scraper is built for it.`,
  cancel: 'Cancel',
};
