/**
 * The arms: each runs the app's own pipeline (app/src/services/identify/pipeline.ts) end to end, with cached I/O
 * that replays the original latencies, so "latency" is what the user waits from scan to Confirm.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProductIdentity } from '../../../app/src/api/types.ts';
import { identityFromOff, IdentifyError } from '../../../app/src/services/identify/parse.ts';
import { DEFAULT_OPTIONS, identifyBarcode, identifyPhoto, lookupOffAny, type IdentifyDeps, type IdentifyOptions } from '../../../app/src/services/identify/pipeline.ts';
import { withProductPhoto } from '../../../app/src/services/photo/index.ts';
import { cachedTransport, FatalApiError, type CallRecord, type TransportOptions } from './claude.ts';
import { fetchImage, lookupOff, preparePhoto } from './off.ts';
import { PHOTO_CACHE_DIR } from './paths.ts';
import type { ArmId, ArmResult, TestItem } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Same cap the app gives the photo step (index.ts PHOTO_WAIT_MS). */
const PHOTO_WAIT_MS = 3000;

interface RunCtx {
  calls: CallRecord[];
  /** Time spent waiting on Open Food Facts politeness gaps for fresh fetches; not part of the app's latency. */
  excludedMs: number;
}

/** OFF lookups from cache, waiting the recorded latency; a fresh fetch's queueing time is excluded. */
function offDep(ctx: RunCtx, noRecord: boolean): IdentifyDeps['lookupOff'] {
  return async (code) => {
    const t0 = performance.now();
    const r = await lookupOff(code);
    if (r.fresh) ctx.excludedMs += Math.max(0, performance.now() - t0 - r.latencyMs);
    else await sleep(r.latencyMs);
    return noRecord ? undefined : r.product;
  };
}

/** The app's photo step (services/photo), cached by the identity fields it searches with. */
function photoDep(ctx: RunCtx): NonNullable<IdentifyDeps['withPhoto']> {
  return async (identity, opts) => {
    if (identity.imageUrl) return withProductPhoto(identity, { ...opts, timeoutMs: PHOTO_WAIT_MS });
    const key = createHash('sha256')
      .update(JSON.stringify([identity.brand, identity.productName, identity.variant, identity.size, identity.manufacturer, !!opts.userPhoto]))
      .digest('hex')
      .slice(0, 24);
    const file = join(PHOTO_CACHE_DIR, `${key}.json`);
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, 'utf8')) as { latencyMs: number; imageUrl?: string; imageSource?: ProductIdentity['imageSource'] };
      await sleep(c.latencyMs);
      return c.imageUrl ? { ...identity, imageUrl: c.imageUrl, imageSource: c.imageSource } : identity;
    }
    const t0 = performance.now();
    const out = await withProductPhoto(identity, { ...opts, timeoutMs: PHOTO_WAIT_MS });
    mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ latencyMs: Math.round(performance.now() - t0), imageUrl: out.imageUrl, imageSource: out.imageSource }));
    return out;
  };
}

export interface ArmConfig {
  options: IdentifyOptions;
  transport: TransportOptions;
}

export const ARM_NEEDS: Record<ArmId, (item: TestItem) => boolean> = {
  A: () => true,
  B: () => true,
  C: (item) => !!item.off, // barcode with the OFF record hidden; products without one are already "no record" in B
  D: (item) => !!item.imageFullUrl,
  E: (item) => !!item.barcodeImageUrl,
};

export async function runArm(arm: ArmId, item: TestItem, cfg: ArmConfig): Promise<ArmResult> {
  const ctx: RunCtx = { calls: [], excludedMs: 0 };
  const deps: IdentifyDeps = {
    lookupOff: offDep(ctx, arm === 'C'),
    transport: cachedTransport(ctx.calls, cfg.transport),
    withPhoto: photoDep(ctx),
  };
  const options = { ...DEFAULT_OPTIONS, ...cfg.options };
  const base = { arm, barcode: item.barcode };
  // Images are fetched and downscaled before the clock starts: the app already has the photo in memory.
  const photoUrl = arm === 'D' ? item.imageFullUrl : arm === 'E' ? item.barcodeImageUrl : undefined;
  const photo = photoUrl ? await preparePhoto(`${item.barcode}.${arm}`, await fetchImage(`${item.barcode}.${arm}`, photoUrl)) : undefined;
  const t0 = performance.now();
  try {
    let identity: ProductIdentity;
    if (arm === 'A') {
      const off = await lookupOffAny(item.barcode, deps.lookupOff, options.offVariants);
      if (!off) throw new IdentifyError('Product not found in Open Food Facts', 'not_found');
      identity = identityFromOff(off, item.barcode);
    } else if (arm === 'B' || arm === 'C') {
      identity = await identifyBarcode(item.barcode, deps, options);
    } else {
      identity = await identifyPhoto({ base64: photo!.base64, mimeType: 'image/jpeg' }, deps, options);
    }
    return finish({ ...base, status: 'ok', identity }, ctx, t0);
  } catch (e) {
    if (e instanceof FatalApiError) throw e;
    const error = e instanceof IdentifyError ? e.code : ((e as { name?: string }).name ?? String(e));
    return finish({ ...base, status: 'error', error }, ctx, t0);
  }
}

function finish(r: ArmResult, ctx: RunCtx, t0: number): ArmResult {
  return {
    ...r,
    latencyMs: Math.round(performance.now() - t0 - ctx.excludedMs),
    calls: ctx.calls,
    costUsd: ctx.calls.reduce((s, c) => s + c.costUsd, 0),
    fellBackToOff: r.identity?.source === 'openfoodfacts' && r.arm !== 'A',
  };
}
