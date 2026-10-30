/**
 * Open Food Facts access for the benchmark: the same product request the app makes, but polite (User-Agent,
 * ≥1.1 s between requests) and cached to disk so reruns never refetch. Also fetches and downscales front photos
 * the way the app's photo path does (≤1024 px longest side, JPEG quality 0.7).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { parseOffResponse, type OffProduct } from '../../../app/src/services/identify/parse.ts';
import { OFF_FIELDS } from '../../../app/src/services/identify/openfoodfacts.ts';
import { IMG_CACHE_DIR, OFF_CACHE_DIR } from './paths.ts';

export const USER_AGENT = 'IdentifyBenchmark/0.1 (Shelvin product-identification benchmark; Node)';
const MIN_GAP_MS = 1100;

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** One request at a time, >=1.1 s apart, two retries. `ms` is the last attempt's own duration (no queueing or backoff). */
function politeFetch(url: string, accept: string): Promise<{ res: Response; ms: number }> {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        if (attempt > 1) throw e;
        console.warn(`retrying after ${(e as Error).name}: ${url}`);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      return { res, ms: Date.now() - started };
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export interface OffLookup {
  /** The product as the app would see it (parseOffResponse), or undefined when OFF has no usable record. */
  product: OffProduct | undefined;
  /** How long the original (uncached) lookup took. */
  latencyMs: number;
  /** Fetched now rather than read from the cache. */
  fresh: boolean;
}

/** `GET /api/v2/product/<code>.json?fields=<the app's fields>`, cached in cache/off/<code>.json. */
export async function lookupOff(code: string): Promise<OffLookup> {
  const file = join(OFF_CACHE_DIR, `${code}.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { body: unknown; latencyMs: number };
    return { product: parseOffResponse(cached.body), latencyMs: cached.latencyMs, fresh: false };
  }
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
  const { res, ms: latencyMs } = await politeFetch(url, 'application/json');
  const body: unknown = res.ok || res.status === 404 ? await res.json() : undefined;
  if (body === undefined) throw new Error(`Open Food Facts ${res.status} for ${code}`);
  mkdirSync(OFF_CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), latencyMs, body }, null, 2));
  return { product: parseOffResponse(body), latencyMs, fresh: true };
}

/** OFF image URLs end in `.<rev>.<size>.jpg` (e.g. `front_es.12.400.jpg`); `.full.jpg` is the original upload. */
export function fullSizeImageUrl(url: string): string {
  return url.replace(/\.(\d+)\.(\d+)\.jpg$/, '.$1.full.jpg');
}

/** An original photo, cached as cache/img/<key>.full.jpg. */
export async function fetchImage(key: string, url: string): Promise<Buffer> {
  const file = join(IMG_CACHE_DIR, `${key}.full.jpg`);
  if (existsSync(file)) return readFileSync(file);
  const { res } = await politeFetch(url, 'image/*');
  if (!res.ok) throw new Error(`Image ${res.status} for ${key}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(IMG_CACHE_DIR, { recursive: true });
  writeFileSync(file, buf);
  return buf;
}

export interface PreparedPhoto {
  base64: string;
  bytes: number;
  width: number;
  height: number;
}

/** Same as the app's preparePhoto: ≤1024 px on the longest side, JPEG quality 0.7. Cached as <key>.1024.jpg. */
export async function preparePhoto(key: string, original: Buffer): Promise<PreparedPhoto> {
  const file = join(IMG_CACHE_DIR, `${key}.1024.jpg`);
  const jpeg = existsSync(file)
    ? readFileSync(file)
    : await sharp(original)
        .rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
  if (!existsSync(file)) writeFileSync(file, jpeg);
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  return { base64: jpeg.toString('base64'), bytes: jpeg.length, width, height };
}
