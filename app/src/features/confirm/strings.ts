// Strings for ② Confirm product.
export const strings = {
  identifying: 'Identifying product…',
  scannedBarcode: 'Scanned barcode',
  typedBarcode: 'Typed barcode',
  yourPhoto: 'Your photo',

  fields: {
    brand: 'Brand',
    productName: 'Product name',
    variant: 'Flavor / variant',
    size: 'Size',
    barcode: 'Barcode',
    manufacturer: 'Manufacturer',
  },
  placeholders: {
    brand: 'e.g. Doritos',
    productName: 'e.g. Doritos Incógnita',
    variant: 'e.g. Incógnita',
    size: 'e.g. 62 g',
    barcode: 'e.g. 7500000000017',
    manufacturer: 'e.g. Sabritas (PepsiCo México)',
  },

  confidence: {
    high: 'High',
    check: 'Check this',
    low: 'Low',
  },
  confirmedByYou: 'Confirmed by you',
  matchLabel: 'Match',
  demo: 'DEMO',
  demoWord: 'Sample product',
  demoResult: 'Demo result',
  demoResultMessage: 'Not your product: this build has no API key, so every scan returns a sample. Add an API key in app/.env to identify for real.',
  lowConfidenceHint: 'We’re not sure about this one. Pick a match below or edit the details.',
  whichSize: 'Which size?',
  checkSizeHint: 'Same product in other sizes. Check the net content on the pack and pick its size.',

  notQuite: 'Not quite?',
  notQuiteHint: 'Pick another match or fix the details.',
  alternativesLabel: 'Other possible matches',
  edit: 'Edit details',
  save: 'Save',
  cancel: 'Cancel',
  requiredHint: 'Brand and product name are required.',

  whatToSearch: 'What to search',
  scanTypes: {
    first_party: 'First party',
    third_party: 'Third party',
    both: 'Both',
  },
  scanTypeHints: {
    first_party: 'The brand’s official pages.',
    third_party: 'Retailers that sell it.',
    both: 'The brand’s official pages and the retailers that sell it.',
  },
  similarLabel: 'Also find similar products',
  similarHint: 'Other flavors and competing brands',

  findPages: 'Find pages',

  identifyFailed: 'We couldn’t identify this product.',
  enterManually: 'Enter details manually',

  noInputTitle: 'Nothing to confirm yet',
  noInputMessage: 'Scan a barcode or take a photo of a product first.',
  backHome: 'Back to Home',
};
