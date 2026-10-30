/**
 * What identification sends to Claude: prompts, schemas and request bodies, plus the call loop (web search
 * continuations, the structured-output fallback). No runtime imports beyond pure modules, so the app
 * (claude.ts supplies the SDK transport) and tools/identify-benchmark run exactly the same requests.
 */
import type { ProductIdentity } from '@/api/types';
import { CLAUDE_MODEL } from '@/services/claude/client';

import { IDENTITY_SCHEMA, IdentifyError, parseClaudeResponse, type ClaudeResponseLike, type OffProduct, type ParseContext } from './parse';

export const SYSTEM = `You identify packaged retail products sold in Mexico, from a photo of the package or from a barcode database record.
Packaging is usually in Spanish. Keep brand and product names exactly as printed on the pack (for example "Doritos Incógnita"); do not translate them.
productName includes the brand. variant is the flavor or variant. size is the net content with its unit, like "62 g".
manufacturer is the company that makes it, for example "Sabritas (PepsiCo México)" or "Barcel (Grupo Bimbo)".
categoryGuess is a Spanish supermarket shelf path joined with " > ", for example "Botanas > Totopos".
confidence is how likely it is that you named exactly this product, flavor and size.
List up to 3 alternatives only when you are unsure. Each alternative must be a different product from your answer and from the other alternatives (another flavor, variant or size); always fill in its variant and size so the difference shows.
If no retail product is visible, return empty strings for brand and productName and confidence 0.`;

export const WEB_SEARCH_SYSTEM = `${SYSTEM}
You can search the web. The database record is thin, so search for the barcode and for the product name to find who sells it and what it is.
A store's own brand counts as the brand (for example IKEA for an IKEA food product). Use only what the search results show; if they do not settle it, lower confidence.
When a result shows this exact barcode on the brand's, the maker's or a store's own product page, that settles it: confidence 0.9 or more.
Answer with only the JSON object.`;

/** The photo prompt also asks for the barcode digits, which the app cross-checks with Open Food Facts. */
export const PHOTO_PROMPT = 'Identify the product in this photo.';
export const PHOTO_BARCODE_PROMPT = `Identify the product in this photo.
If a barcode is visible, also copy the digits printed under it into barcodeDigits (digits only, usually 13). Leave barcodeDigits "" when no barcode is visible or you cannot read every digit.`;

/** IDENTITY_SCHEMA plus the barcode digits read off the pack. */
export const PHOTO_BARCODE_SCHEMA = {
  ...IDENTITY_SCHEMA,
  required: [...IDENTITY_SCHEMA.required, 'barcodeDigits'],
  properties: {
    ...IDENTITY_SCHEMA.properties,
    barcodeDigits: { type: 'string', description: 'Digits printed under the barcode, if one is visible and fully legible; else "".' },
  },
} as const;

/** Searches one identification may run; one or two usually settle it. */
export const MAX_SEARCHES = 3;
export const MAX_CONTINUATIONS = 2;
export const MAX_TOKENS = 16000;

export type Effort = 'low' | 'medium';

/** User content blocks we send (a subset of the SDK's BetaContentBlockParam). */
export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } };

/** One identification request, before it becomes a Messages API body. */
export interface IdentifyRequest {
  /** Short name for logs and the benchmark cache. */
  kind: 'barcode' | 'barcode-web' | 'photo';
  model: string;
  system: string;
  content: UserBlock[];
  effort: Effort;
  webSearch: boolean;
  schema: object;
}

/** Message body passed to `client.beta.messages.create` (kept structural; claude.ts casts it to the SDK type). */
export interface MessageBody {
  model: string;
  max_tokens: number;
  betas?: string[];
  fallbacks?: 'default';
  system: string;
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  tools?: unknown[];
  output_config: { effort: Effort; format?: { type: 'json_schema'; schema: object } };
}

/** The response fields the loop reads. */
export interface MessageLike extends ClaudeResponseLike {
  content: readonly ({ type: string; text?: string } & Record<string, unknown>)[];
}

/** Sends one Messages API request. Errors carry `status` and `message` like the SDK's APIError. */
export type Transport = (body: MessageBody) => Promise<MessageLike>;

/** Models with the API's server-side refusal fallback (Haiku has none). */
const HAS_FALLBACK = /^claude-(opus|sonnet|fable)-/;

export function barcodeRequest(
  code: string,
  off: OffProduct | undefined,
  opts: { webSearch?: boolean; model?: string; webModel?: string; webEffort?: Effort; photoHint?: PhotoHint } = {},
): IdentifyRequest {
  const record = off ? `Open Food Facts record:\n${JSON.stringify(off, null, 2)}` : 'No database record was found.';
  const text = opts.photoHint && off
    ? `Barcode ${code}, read off a photo of the pack. ${record}\nThe photo itself was read as: ${JSON.stringify(opts.photoHint)}.\n${PHOTO_HINT_RULE}`
    : opts.webSearch
    ? `Barcode ${code}. ${record}\nSearch the web for barcode ${code}${off?.product_name ? ` and for "${off.product_name}"` : ''}, then give the product identity.`
    : off
      ? `Barcode ${code}. ${record}\nNormalize this into the product identity.`
      : `Barcode ${code}. ${record} Identify the product only if you are confident; otherwise give your best guess with low confidence.`;
  return {
    kind: opts.webSearch ? 'barcode-web' : 'barcode',
    // Web search needs a model with web_search_20260209 (Opus or Sonnet); the normalize call may use a faster one.
    model: opts.webSearch ? (opts.webModel ?? CLAUDE_MODEL) : (opts.model ?? CLAUDE_MODEL),
    system: opts.webSearch ? WEB_SEARCH_SYSTEM : SYSTEM,
    content: [{ type: 'text', text }],
    effort: opts.webSearch ? (opts.webEffort ?? 'medium') : 'low',
    webSearch: !!opts.webSearch,
    schema: IDENTITY_SCHEMA,
  };
}

/** What vision read on the pack, passed with the barcode record when the photo showed a barcode. */
export type PhotoHint = Pick<ProductIdentity, 'brand' | 'productName' | 'variant' | 'size'>;

export const PHOTO_HINT_RULE =
  'The barcode record names the exact product. Use the photo reading only for what the record lacks or gets wrong (a size or flavor the photo shows clearly); if the photo shows only the back or the barcode, its guess of the product may be wrong. Give the product identity.';

export function photoRequest(photo: { base64: string; mimeType: 'image/jpeg' | 'image/png' }, opts: { readBarcode?: boolean } = {}): IdentifyRequest {
  return {
    kind: 'photo',
    model: CLAUDE_MODEL,
    system: SYSTEM,
    content: [
      { type: 'image', source: { type: 'base64', media_type: photo.mimeType, data: photo.base64 } },
      { type: 'text', text: opts.readBarcode ? PHOTO_BARCODE_PROMPT : PHOTO_PROMPT },
    ],
    effort: 'medium',
    webSearch: false,
    schema: opts.readBarcode ? PHOTO_BARCODE_SCHEMA : IDENTITY_SCHEMA,
  };
}

/** The Messages API body for a request; `structured` false drops the JSON schema (plain JSON in the text). */
export function messageBody(req: IdentifyRequest, structured: boolean, messages?: MessageBody['messages']): MessageBody {
  return {
    model: req.model,
    max_tokens: MAX_TOKENS,
    // Server-side refusal fallback: a declined request is retried on a model chosen by the API.
    ...(HAS_FALLBACK.test(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    system: req.system,
    messages: messages ?? [{ role: 'user', content: req.content }],
    ...(req.webSearch
      ? {
          tools: [
            {
              type: 'web_search_20260209',
              name: 'web_search',
              max_uses: MAX_SEARCHES,
              user_location: { type: 'approximate', country: 'MX', timezone: 'America/Mexico_City' },
            },
          ],
        }
      : {}),
    output_config: structured ? { effort: req.effort, format: { type: 'json_schema', schema: req.schema } } : { effort: req.effort },
  };
}

/** Remembered for the session if the API refuses structured output next to web search. */
let structuredWithSearch = true;

function isFormatRejection(e: unknown): boolean {
  const err = e as { status?: unknown; message?: unknown };
  return err?.status === 400 && typeof err.message === 'string' && /output_config|format|citation/i.test(err.message);
}

async function send(transport: Transport, req: IdentifyRequest, messages?: MessageBody['messages']): Promise<MessageLike> {
  const structured = !req.webSearch || structuredWithSearch;
  if (structured) {
    try {
      return await transport(messageBody(req, true, messages));
    } catch (e) {
      // Only with web search: fall back to a plain JSON answer, which parseClaudeResponse reads out of the text.
      if (!req.webSearch || !isFormatRejection(e)) throw e;
      structuredWithSearch = false;
    }
  }
  return transport(messageBody(req, false, messages));
}

/** Runs a request to the end (resuming paused web searches) and returns the raw final turn plus Claude's answer. */
export async function runRequest(transport: Transport, req: IdentifyRequest): Promise<ClaudeResponseLike> {
  if (!req.webSearch) return send(transport, req);
  const messages: MessageBody['messages'] = [{ role: 'user', content: req.content }];
  const blocks: MessageLike['content'][number][] = [];
  let response: MessageLike | undefined;
  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    response = await send(transport, req, messages);
    blocks.push(...response.content);
    if (response.stop_reason !== 'pause_turn') break;
    // The server paused its tool loop: send the turn back unchanged and it resumes.
    messages.push({ role: 'assistant', content: response.content });
  }
  return { stop_reason: response?.stop_reason ?? null, content: blocks };
}

/** The identity and, for a photo request, the barcode digits Claude read off the pack. */
export interface AskResult {
  identity: ProductIdentity;
  barcodeDigits?: string;
}

export async function ask(transport: Transport, req: IdentifyRequest, ctx: ParseContext): Promise<AskResult> {
  const res = await runRequest(transport, req);
  try {
    return { identity: parseClaudeResponse(res, ctx), barcodeDigits: readBarcodeDigits(res) };
  } catch (e) {
    // No product named, but barcode digits read (a close-up of the barcode): the caller can look the code up.
    const digits = readBarcodeDigits(res);
    if (digits && e instanceof IdentifyError && e.code === 'not_a_product') throw new BarcodeOnlyError(digits);
    throw e;
  }
}

/** Vision read a barcode but couldn't name the product from the photo alone. */
export class BarcodeOnlyError extends Error {
  readonly digits: string;

  constructor(digits: string) {
    super('Only a barcode was readable in this photo');
    this.name = 'BarcodeOnlyError';
    this.digits = digits;
  }
}

/** barcodeDigits from the answer JSON, digits only; undefined when absent. */
export function readBarcodeDigits(res: ClaudeResponseLike): string | undefined {
  const text = res.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const m = /"barcodeDigits"\s*:\s*"([^"]*)"/.exec(text);
  const digits = m?.[1]?.replace(/\D/g, '');
  return digits ? digits : undefined;
}
