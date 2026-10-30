import type Anthropic from '@anthropic-ai/sdk';

import { getClaudeClient } from '@/services/claude/client';

import type { MessageBody, MessageLike, Transport } from './requests';

/**
 * The SDK transport for identification: one `client.beta.messages.create` call. Prompts, request bodies and the call
 * loop live in requests.ts (pure, shared with tools/identify-benchmark).
 */
export const claudeTransport: Transport = async (body: MessageBody): Promise<MessageLike> => {
  const params = body as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  const response = await getClaudeClient().beta.messages.create(params);
  return response as unknown as MessageLike;
};
