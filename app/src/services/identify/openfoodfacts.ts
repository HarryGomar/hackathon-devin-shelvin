import { parseOffResponse, type OffProduct } from './parse';

export const OFF_FIELDS = 'code,product_name,product_name_es,brands,quantity,image_front_url,image_url,categories,manufacturing_places';

/** Look a barcode up in Open Food Facts (free, no key). Undefined when unknown or unreachable. */
export async function lookupOpenFoodFacts(code: string, timeoutMs = 8000): Promise<OffProduct | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Shelvin/1.0' }, signal: controller.signal },
    );
    if (!res.ok) return undefined;
    return parseOffResponse(await res.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
