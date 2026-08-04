/** 入口注册表：协议 → 读入函数。新增协议只在这里落地一次。 */
import type { ClientRequestReadResult, IRProtocol } from "../ir/types.ts";
import { readAnthropicMessagesRequest } from "./anthropic_messages.ts";
import { readChatCompletionsRequest } from "./openai_chat_completions.ts";
import { readResponsesRequest } from "./openai_responses.ts";

export type ClientRequestReader = (raw: unknown, traceId: string) => ClientRequestReadResult;

export const CLIENT_REQUEST_READERS: Readonly<Record<IRProtocol, ClientRequestReader>> = {
  anthropic_messages: readAnthropicMessagesRequest,
  openai_responses: readResponsesRequest,
  openai_chat_completions: readChatCompletionsRequest,
};

export const INGRESS_PATHS: Readonly<Record<string, IRProtocol>> = {
  "/v1/messages": "anthropic_messages",
  "/v1/responses": "openai_responses",
  "/v1/chat/completions": "openai_chat_completions",
};

export function readClientRequestForProtocol(protocol: IRProtocol, raw: unknown, traceId: string): ClientRequestReadResult {
  return CLIENT_REQUEST_READERS[protocol](raw, traceId);
}

export { readAnthropicMessagesRequest, readChatCompletionsRequest, readResponsesRequest };
