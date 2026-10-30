/**
 * The Claude transport the benchmark gives the app's pipeline: the app builds every request body itself
 * (app/src/services/identify/requests.ts); this sends it with the same client options as the app (60 s timeout,
 * 1 retry), caches the response on disk by a hash of the body, and on a cache hit waits the latency the original call
 * took, so end-to-end timings replay faithfully. Every fresh call's cost is added to cache/spend.json.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import type { MessageBody, MessageLike, Transport } from '../../../app/src/services/identify/requests.ts';
import { APP_ENV_FILE, CACHE_DIR, CLAUDE_CACHE_DIR } from './paths.ts';
import type { Usage } from './types.ts';

// US$ per million tokens, from the claude-api skill's model table. Web search is $10 per 1,000 searches.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const SEARCH_USD = 0.01;
export const PRICING_NOTE =
  'Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 per million input / output tokens, web search $10 per 1,000 (claude-api skill price table)';

export const TIMEOUT_MS = 60_000;
export const MAX_RETRIES = 1;

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']!;
  return (
    (u.input_tokens * p.input + u.cache_creation_input_tokens * p.input * 1.25 + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1e6 +
    u.web_search_requests * SEARCH_USD
  );
}

/** ANTHROPIC_API_KEY, else EXPO_PUBLIC_ANTHROPIC_API_KEY from app/.env (this checkout's, then the main checkout's). Never printed. */
export function resolveApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const candidates = [APP_ENV_FILE];
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(join(common, '..', 'app', '.env'));
  } catch {
    // not in a git checkout; only this checkout's app/.env
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*EXPO_PUBLIC_ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      const value = m?.[1]?.replace(/^['"]|['"]$/g, '').trim();
      if (value) return value;
    }
  }
  return undefined;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new FatalApiError('No API key: set ANTHROPIC_API_KEY or EXPO_PUBLIC_ANTHROPIC_API_KEY in app/.env');
  client ??= new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return client;
}

/** Authentication / permission failures, or the cost cap: no point making further calls. */
export class FatalApiError extends Error {}

/** One Claude call made during a pipeline run. */
export interface CallRecord {
  kind: string;
  requestedModel: string;
  model?: string;
  latencyMs: number;
  usage?: Usage;
  costUsd: number;
  cached: boolean;
  error?: string;
}

interface CacheEntry {
  at: string;
  latencyMs: number;
  response: MessageLike & { model?: string; usage?: Record<string, unknown> };
}

const SPEND_FILE = join(CACHE_DIR, 'spend.json');

/** Total fresh spend recorded across all runs (cache/spend.json). */
export function totalSpend(): number {
  return existsSync(SPEND_FILE) ? (JSON.parse(readFileSync(SPEND_FILE, 'utf8')) as { usd: number }).usd : 0;
}
function addSpend(usd: number): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cur = totalSpend();
  writeFileSync(SPEND_FILE, JSON.stringify({ usd: cur + usd, updatedAt: new Date().toISOString() }, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usageOf(res: CacheEntry['response']): Usage {
  const u = (res.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const server = (u.server_tool_use ?? {}) as Record<string, unknown>;
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    web_search_requests: n(server.web_search_requests),
  };
}

export interface TransportOptions {
  fresh: boolean;
  /** Stop making fresh calls once this run has spent this much. */
  maxCostUsd: number;
  /** Shared across all pipeline runs of one bench invocation. */
  spent: { usd: number };
  /** Hold back this much of the cap for calls already in flight. */
  reserveUsd?: number;
}

/** A transport for one pipeline run; its calls land in `calls`. */
export function cachedTransport(calls: CallRecord[], opts: TransportOptions): Transport {
  return async (body: MessageBody) => {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    const file = join(CLAUDE_CACHE_DIR, `${hash}.json`);
    const kind = body.tools ? 'web' : (body.output_config.format?.schema as { properties?: Record<string, unknown> })?.properties?.barcodeDigits ? 'photo+bc' : 'call';
    if (!opts.fresh && existsSync(file)) {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as CacheEntry;
      await sleep(entry.latencyMs);
      const usage = usageOf(entry.response);
      calls.push({ kind, requestedModel: body.model, model: entry.response.model, latencyMs: entry.latencyMs, usage, costUsd: costUsd(entry.response.model ?? body.model, usage), cached: true });
      return entry.response;
    }
    if (opts.spent.usd + (opts.reserveUsd ?? 0) >= opts.maxCostUsd) throw new FatalApiError(`cost cap $${opts.maxCostUsd} reached ($${opts.spent.usd.toFixed(2)} spent)`);
    const started = performance.now();
    try {
      const response = (await getClient().beta.messages.create(body as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)) as unknown as CacheEntry['response'];
      const latencyMs = Math.round(performance.now() - started);
      mkdirSync(CLAUDE_CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), latencyMs, response } satisfies CacheEntry));
      const usage = usageOf(response);
      const cost = costUsd(response.model ?? body.model, usage);
      opts.spent.usd += cost;
      addSpend(cost);
      calls.push({ kind, requestedModel: body.model, model: response.model, latencyMs, usage, costUsd: cost, cached: false });
      return response;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new FatalApiError(`${e.name} ${e.status}: check the API key`);
      const latencyMs = Math.round(performance.now() - started);
      const error = e instanceof Anthropic.APIError ? `${e.name} ${e.status ?? ''}`.trim() : (e as Error).name;
      calls.push({ kind, requestedModel: body.model, latencyMs, costUsd: 0, cached: false, error });
      throw e;
    }
  };
}
