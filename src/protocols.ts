/**
 * 两张注册表 —— 这套架构的全部对外面。
 *
 * `INGRESS_CODECS` 是**封闭**的：世界上的 agent 客户端协议就这三种，补齐一次之后
 * 新增上游再也不需要碰它。
 *
 * `EGRESS_PROVIDERS` 是**开放**的：接 Gemini CloudCode、Windsurf Connect、Bedrock
 * 都只是往这里加一行（两个函数：lower + lift），入口侧零改动，一次性多出三条路由。
 */
import { createAnthropicEgress, type AnthropicEgressOptions } from "./egress/anthropic.ts";
import { encodeAnthropicResponse } from "./ingress/anthropic_encode.ts";
import { decodeAnthropicMessages } from "./ingress/anthropic_messages.ts";
import { decodeOpenAIChatCompletions } from "./ingress/openai_chat_completions.ts";
import { encodeChatCompletionsResponse, encodeResponsesResponse } from "./ingress/openai_encode.ts";
import { decodeOpenAIResponses } from "./ingress/openai_responses.ts";
import type {
  IREgressDescriptor, IREgressRegistry, IRIngressCodec, IRIngressRegistry,
} from "./ir/codec.ts";
import type { IRProtocol } from "./ir/types.ts";

// ── 入口：封闭集，三个 ──────────────────────────────────────────────────────

const anthropicMessages: IRIngressCodec = {
  protocol: "anthropic_messages",
  decodeRequest: decodeAnthropicMessages,
  encodeResponse: encodeAnthropicResponse,
};

const openaiResponses: IRIngressCodec = {
  protocol: "openai_responses",
  decodeRequest: decodeOpenAIResponses,
  encodeResponse: encodeResponsesResponse,
};

const openaiChatCompletions: IRIngressCodec = {
  protocol: "openai_chat_completions",
  decodeRequest: decodeOpenAIChatCompletions,
  encodeResponse: encodeChatCompletionsResponse,
};

export const INGRESS_CODECS = {
  anthropic_messages: anthropicMessages,
  openai_responses: openaiResponses,
  openai_chat_completions: openaiChatCompletions,
} as const satisfies IRIngressRegistry;

/** HTTP 路径 → 协议。入口端点只在这里定义一次。 */
export const INGRESS_PATHS: Readonly<Record<string, IRProtocol>> = {
  "/v1/messages": "anthropic_messages",
  "/v1/responses": "openai_responses",
  "/v1/chat/completions": "openai_chat_completions",
};

// ── 出口：开放集，当前一家 ──────────────────────────────────────────────────

const anthropicEgress: IREgressDescriptor<AnthropicEgressOptions> = {
  name: "anthropic",
  wire: "anthropic_messages_sse",
  create: createAnthropicEgress,
};

export const EGRESS_PROVIDERS = {
  anthropic: anthropicEgress,
} as const satisfies IREgressRegistry;

export { anthropicEgress, anthropicMessages, openaiChatCompletions, openaiResponses };
