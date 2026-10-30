import type Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-opus-5-5';

/** True when a key is bundled. Live features also need their own EXPO_PUBLIC_*_MODE switch. */
export const hasClaudeKey = !!process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;

type Sdk = typeof import('@anthropic-ai/sdk');

let sdk: Sdk | undefined;
let client: Anthropic | undefined;

/** The SDK module, for its error classes. */
export function loadAnthropicSdk(): Sdk {
  // Loaded lazily (mock mode never evaluates the SDK) and via require() so Metro picks the SDK's CommonJS build:
  // its ESM build has an internal import cycle that throws a TDZ ReferenceError under Expo dev-mode React Refresh.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sdk ??= require('@anthropic-ai/sdk') as Sdk;
  return sdk;
}

/** Shared client for identification and search. Per-request `timeout` / `signal` override the defaults. */
export function getClaudeClient(): Anthropic {
  if (!client) {
    const { default: AnthropicClient } = loadAnthropicSdk();
    client = new AnthropicClient({
      apiKey: process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY,
      // The key ships in the app bundle (team-only demo, user decision). Needed on web; harmless on native.
      dangerouslyAllowBrowser: true,
      timeout: 60_000,
      maxRetries: 1,
    });
  }
  return client;
}
