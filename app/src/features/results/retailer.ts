import type { SourcePage } from '@/api/types';

/** Suffix the API may add to a brand's own site, e.g. "Takis (official site)". */
const OFFICIAL_SUFFIX = /\s*\((official site|sitio oficial)\)\s*$/i;

/**
 * Retailer name to show and whether it's the brand's own site. `sourceType` comes from the page when the app has it;
 * listings don't carry it yet, so otherwise the "(official site)" suffix decides.
 */
export function retailerLabel(retailerName: string, sourceType?: SourcePage['sourceType']) {
  const trimmed = retailerName.trim();
  const name = trimmed.replace(OFFICIAL_SUFFIX, '') || trimmed;
  return { name, official: sourceType ? sourceType === 'first_party' : name !== trimmed };
}
