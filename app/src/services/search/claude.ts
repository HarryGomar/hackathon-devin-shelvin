import type Anthropic from '@anthropic-ai/sdk';

import type { JobProgress, SearchRequest } from '@/api/types';
import { CLAUDE_MODEL, getClaudeClient, loadAnthropicSdk } from '@/services/claude/client';

import {
  buildSearchPrompt,
  domainPolicy,
  maxSearches,
  parseSearchResponse,
  SEARCH_SCHEMA,
  SEARCH_SYSTEM,
  SearchError,
  type ParsedSearch,
} from './parse';

/** Whole search, including pause_turn continuations. */
export const SEARCH_TIMEOUT_MS = 90_000;
const MAX_CONTINUATIONS = 2;

// Claude Opus 5.5 list prices (US$ per token / per search), for the dev cost log.
const PRICE = { input: 4 / 1e6, output: 20 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 5 / 1e6, search: 0.01 };

type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export interface SearchOptions {
  onProgress?: (progress: JobProgress) => void;
}

/** One search may run without structured output if the API rejects it next to web search; remembered for the session. */
let structuredOutput = true;

/**
 * Ask Claude (with web search) for the product's official page and Mexican store pages, verified.
 * Throws SearchError (or Error with a readable message) on failure.
 */
export async function searchPagesWithClaude(req: SearchRequest, opts: SearchOptions = {}): Promise<ParsedSearch> {
  const started = Date.now();
  const deadline = started + SEARCH_TIMEOUT_MS;
  const policy = domainPolicy(req);
  const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: maxSearches(req),
      ...(policy.allowed ? { allowed_domains: policy.allowed } : { blocked_domains: policy.blocked }),
      user_location: { type: 'approximate', country: 'MX', timezone: 'America/Mexico_City' },
    },
  ];
  const messages: MessageParam[] = [{ role: 'user', content: buildSearchPrompt(req) }];
  const content: Message['content'] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let response: Message | undefined;
  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      response = await create(messages, tools, deadline, controller.signal);
      content.push(...response.content);
      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      usage.searches += response.usage.server_tool_use?.web_search_requests ?? 0;
      if (response.stop_reason !== 'pause_turn') break;
      // The server paused its tool loop: send the turn back unchanged and it resumes.
      messages.push({ role: 'assistant', content: response.content });
      opts.onProgress?.({ step: 'search', message: `Still searching (${usage.searches} searches so far)`, percent: 55 });
    }
  } catch (e) {
    throw readableError(e, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
    if (__DEV__) logUsage(usage, Date.now() - started);
  }

  opts.onProgress?.({ step: 'verify', message: 'Checking each page is the same product', percent: 75 });
  const parsed = parseSearchResponse({ stop_reason: response?.stop_reason ?? null, content }, req);
  if (__DEV__) {
    for (const p of parsed.pages) {
      console.log(`[claude-search] ${p.matchType} ${p.verification.status} ${p.verification.confidence.toFixed(2)} ${p.url} | ${p.verification.reason}`);
    }
  }
  return parsed;
}

async function create(messages: MessageParam[], tools: Anthropic.Beta.Messages.BetaToolUnion[], deadline: number, signal: AbortSignal): Promise<Message> {
  const timeout = Math.max(1_000, deadline - Date.now());
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    // Server-side refusal fallback: a declined request is retried on a model chosen by the API.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    system: SEARCH_SYSTEM,
    tools,
    messages,
  };
  const client = getClaudeClient();
  if (structuredOutput) {
    try {
      return await client.beta.messages.create(
        { ...body, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SEARCH_SCHEMA } } },
        { timeout, signal, maxRetries: 0 },
      );
    } catch (e) {
      // Fallback for an API that refuses structured output alongside web search: plain JSON answer, parsed strictly.
      if (!(e instanceof loadAnthropicSdk().BadRequestError) || !/output_config|format|citation/i.test(e.message)) throw e;
      structuredOutput = false;
      if (__DEV__) console.warn('[claude-search] structured output rejected with web search; using plain JSON');
    }
  }
  return client.beta.messages.create({ ...body, output_config: { effort: 'medium' } }, { timeout, signal, maxRetries: 0 });
}

function readableError(e: unknown, aborted: boolean): Error {
  if (e instanceof SearchError) return e;
  const sdk = loadAnthropicSdk();
  if (aborted || e instanceof sdk.APIUserAbortError || e instanceof sdk.APIConnectionTimeoutError) {
    return new Error(`The search took longer than ${SEARCH_TIMEOUT_MS / 1000} s. Try again.`);
  }
  if (e instanceof sdk.AuthenticationError) return new Error('Live search is not set up: the Claude API key was rejected.');
  if (e instanceof sdk.RateLimitError) return new Error('Live search is busy (rate limited). Wait a minute and try again.');
  if (e instanceof sdk.APIConnectionError) return new Error('Could not reach Claude. Check the connection and try again.');
  if (e instanceof sdk.APIError) return new Error(`Live search failed (${e.status ?? 'error'}): ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

function logUsage(u: { input: number; output: number; cacheRead: number; cacheWrite: number; searches: number }, ms: number) {
  const cost = u.input * PRICE.input + u.output * PRICE.output + u.cacheRead * PRICE.cacheRead + u.cacheWrite * PRICE.cacheWrite + u.searches * PRICE.search;
  console.log(
    `[claude-search] ${u.searches} searches, ${u.input} in + ${u.cacheRead} cache-read + ${u.cacheWrite} cache-write / ${u.output} out tokens, ~US$${cost.toFixed(3)}, ${(ms / 1000).toFixed(1)} s`,
  );
}
