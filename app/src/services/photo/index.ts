import type { ProductIdentity } from '@/api/types';

import { pickImage } from './match';
import { searchOffImage } from './off-search';

/**
 * The identity with a photo, by priority: the image it already has (the exact barcode's Open Food Facts record) →
 * an Open Food Facts search match → the user's own photo of the pack → none. Free (OFF only), capped at `timeoutMs` (5 s),
 * never throws: without a match the identity comes back unchanged.
 */
export async function withProductPhoto(
  identity: ProductIdentity,
  opts: { userPhoto?: string; timeoutMs?: number } = {},
): Promise<ProductIdentity> {
  if (identity.imageUrl) return { ...identity, imageSource: identity.imageSource ?? 'openfoodfacts' };
  const picked = pickImage({ offSearch: await searchOffImage(identity, opts.timeoutMs), userPhoto: opts.userPhoto });
  return picked.imageUrl ? { ...identity, ...picked } : identity;
}
