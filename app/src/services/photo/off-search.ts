import { bestImage, parseOffSearch, searchBrandTags, type OffSearchHit, type PhotoTarget } from './match';

const FIELDS = 'code,product_name,product_name_es,brands,quantity,image_front_url';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Shelvin/1.0' };

/** GET → hits, or undefined when the request failed or the body isn't JSON (OFF answers rate limits with an HTML 503). */
async function getHits(url: string, signal: AbortSignal): Promise<OffSearchHit[] | undefined> {
  const res = await fetch(url, { headers: HEADERS, signal });
  if (!res.ok) return undefined;
  try {
    return parseOffSearch(await res.json());
  } catch {
    return undefined;
  }
}

/**
 * Best Open Food Facts front image for the product (free, no key). Searches `api/v2/search` by brand tag in Mexico
 * (the brand, then the maker) and matches name, flavor and size locally. If that service is down or rate-limited,
 * falls back to search.openfoodfacts.org (full text; native only, it sends no CORS header). Undefined when nothing
 * matches or after `timeoutMs`; never throws.
 */
export async function searchOffImage(target: PhotoTarget, timeoutMs = 5000): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let answered = false;
    for (const tag of searchBrandTags(target)) {
      const hits = await getHits(
        `https://world.openfoodfacts.org/api/v2/search?brands_tags=${encodeURIComponent(tag)}&countries_tags_en=mexico&page_size=100&fields=${FIELDS}`,
        controller.signal,
      );
      if (!hits) continue;
      answered = true;
      const url = bestImage(target, hits);
      if (url) return url;
    }
    if (answered) return undefined;
    const q = `${target.productName} ${target.variant ?? ''} countries_tags:"en:mexico"`;
    const hits = await getHits(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=50&fields=${FIELDS}`, controller.signal);
    return hits ? bestImage(target, hits) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
