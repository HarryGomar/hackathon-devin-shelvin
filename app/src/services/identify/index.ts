import type { ProductIdentity, ScanInput } from '@/api/types';
import { hasClaudeKey } from '@/services/claude/client';
import { withProductPhoto } from '@/services/photo';

import { claudeTransport } from './claude';
import { identifyMock } from './mock';
import { lookupOpenFoodFacts } from './openfoodfacts';
import { DEFAULT_OPTIONS, identifyBarcode, identifyPhoto, type IdentifyDeps } from './pipeline';

export { MOCK_FAIL_BARCODE } from './mock';
export { IdentifyError } from './parse';

export type IdentifyMode = 'mock' | 'live';

/** Who identifies: the app itself (Open Food Facts + Claude from the phone), or the mock. The backend has no /identify. */
export type IdentifyRoute = 'app' | 'mock';

/**
 * `app` (Open Food Facts + Claude from the phone) only when `EXPO_PUBLIC_IDENTIFY_MODE=live` and a key is set; those calls cost money. Else the mock.
 */
export const identifyRoute: IdentifyRoute =
  process.env.EXPO_PUBLIC_IDENTIFY_MODE === 'live' && hasClaudeKey ? 'app' : 'mock';

export const identifyMode: IdentifyMode = identifyRoute === 'mock' ? 'mock' : 'live';

/**
 * How long identification waits for a photo (usually ~1 s; the fallback search ~2 s). Short so Confirm isn't held up;
 * attaching the photo after Confirm shows would need the Confirm flow to update the identity (follow-up).
 */
const PHOTO_WAIT_MS = 3000;

const deps: IdentifyDeps = {
  lookupOff: (code) => lookupOpenFoodFacts(code),
  transport: claudeTransport,
  withPhoto: (identity, opts) => withProductPhoto(identity, { ...opts, timeoutMs: PHOTO_WAIT_MS }),
};

/**
 * Works out brand, product, flavor and size from a barcode or photo (plan §10). Throws on failure.
 * The flow is in pipeline.ts (barcode: Open Food Facts → Claude, web search for thin records; photo: Claude vision),
 * then the photo (services/photo): OFF exact image → OFF search → the user's photo; free and capped at 3 s.
 * Identification stays on the phone even when the API is live (docs/backend-spec.md §6: the backend has no /identify).
 */
export async function identifyProduct(input: ScanInput): Promise<ProductIdentity> {
  if (identifyRoute === 'mock') return identifyMock(input);
  if (input.kind === 'photo') return identifyPhoto(input, deps, DEFAULT_OPTIONS);
  return identifyBarcode(input.code, deps, DEFAULT_OPTIONS);
}
