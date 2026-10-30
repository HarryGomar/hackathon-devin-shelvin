import { PRODUCTS, SAMPLE_BARCODES } from '@/api/mock/fixtures';
import type { ProductIdentity, ScanInput } from '@/api/types';

// Kept apart from ./index so the mock API can use it without importing the live identify flow (and api/client).

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Barcode that makes mock identification fail, to demo the error state. */
export const MOCK_FAIL_BARCODE = '7500000000000';

/** Canned identification for demo mode and the mock API. */
export async function identifyMock(input: ScanInput): Promise<ProductIdentity> {
  await wait(1500);
  const doritos = PRODUCTS['doritos-incognita'];

  if (input.kind === 'photo') {
    return {
      ...doritos,
      barcode: undefined,
      confidence: 0.88,
      alternatives: [
        { brand: 'Doritos', productName: 'Doritos Incógnita', size: '145 g', variant: 'Incógnita', confidence: 0.07 },
        { brand: 'Doritos', productName: 'Doritos Dinamita', variant: 'Dinamita', confidence: 0.03 },
      ],
    };
  }

  const code = input.code.trim();
  if (code === MOCK_FAIL_BARCODE) throw new Error('Could not identify this product (mock failure)');
  if (code === SAMPLE_BARCODES.doritosIncognita) return doritos;
  if (code === SAMPLE_BARCODES.takisFuego) return PRODUCTS['takis-fuego'];

  // Unknown barcode: a low-confidence guess so the confirm screen's "Check this" path is easy to demo.
  return {
    ...doritos,
    barcode: code,
    confidence: 0.55,
    alternatives: [
      { brand: 'Takis', productName: 'Takis Fuego', variant: 'Fuego', size: '90 g', confidence: 0.25 },
      { brand: 'Doritos', productName: 'Doritos Nacho', variant: 'Nacho', size: '62 g', confidence: 0.15 },
    ],
  };
}
