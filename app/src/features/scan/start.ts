import { router } from 'expo-router';

import { SAMPLE_BARCODES } from '@/api/mock/fixtures';
import type { ScanInput } from '@/api/types';
import { useSession } from '@/state/session';

import { prepareSamplePhoto } from './photo';

/**
 * Every entry path ends here: reset the flow with the new input, then open Confirm.
 * The camera replaces itself so Back from Confirm returns to Home, not the camera.
 */
export function beginScan(input: ScanInput, navigation: 'push' | 'replace' = 'push') {
  useSession.getState().startScan(input);
  if (navigation === 'replace') router.replace('/confirm');
  else router.push('/confirm');
}

export function beginSampleBarcodeScan(navigation: 'push' | 'replace' = 'push') {
  beginScan({ kind: 'barcode', code: SAMPLE_BARCODES.doritosIncognita, format: 'ean13' }, navigation);
}

export async function beginSamplePhotoScan(navigation: 'push' | 'replace' = 'push') {
  beginScan(await prepareSamplePhoto(), navigation);
}
