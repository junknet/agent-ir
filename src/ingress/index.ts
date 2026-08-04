/** ingress 注册表：协议 → decode。新增协议只在这里落地一次。 */
import type { IRDecodeResult, IRProtocol } from "../ir/types.ts";
import { decodeAnthropicMessages } from "./anthropic_messages.ts";
import { decodeOpenAIChatCompletions } from "./openai_chat_completions.ts";
import { decodeOpenAIResponses } from "./openai_responses.ts";

export type IRDecoder = (raw: unknown, traceId: string) => IRDecodeResult;

export const INGRESS_DECODERS: Readonly<Record<IRProtocol, IRDecoder>> = {
  anthropic_messages: decodeAnthropicMessages,
  openai_responses: decodeOpenAIResponses,
  openai_chat_completions: decodeOpenAIChatCompletions,
};

export const INGRESS_PATHS: Readonly<Record<string, IRProtocol>> = {
  "/v1/messages": "anthropic_messages",
  "/v1/responses": "openai_responses",
  "/v1/chat/completions": "openai_chat_completions",
};

export function decodeForProtocol(protocol: IRProtocol, raw: unknown, traceId: string): IRDecodeResult {
  return INGRESS_DECODERS[protocol](raw, traceId);
}

export { decodeAnthropicMessages, decodeOpenAIChatCompletions, decodeOpenAIResponses };
