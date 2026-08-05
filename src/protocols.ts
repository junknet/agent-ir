/**
 * 两张注册表 —— 这套架构的全部对外面。
 *
 * `INGRESS_CODECS` 是**封闭**的：本网关支持的主流 Agent 对话协议固定为三种，补齐后
 * 新增上游再也不需要碰它。
 *
 * `OUTBOX_REGISTRY` 是**开放**的：接 Gemini CloudCode、Windsurf Connect、Bedrock
 * 都只是往这里加一行（两个函数：writeOutboxRequest + readOutboxResponse），入口侧零改动，一次性多出三条路由。
 */
import { createAnthropicOutbox, type AnthropicOutboxOptions } from "./egress/anthropic.ts";
import { createCopilotOutbox, type CopilotOutboxOptions } from "./egress/copilot.ts";
import { createGeminiCloudCodeOutbox, type GeminiCloudCodeOutboxOptions } from "./egress/gemini_cloudcode.ts";
import { createOpenAIChatOutbox, type OpenAIChatOutboxOptions } from "./egress/openai_chat_completions.ts";
import { createOpenAIResponsesOutbox, type OpenAIResponsesOutboxOptions } from "./egress/openai_responses.ts";
import { createWindsurfOutbox, type WindsurfOutboxOptions } from "./egress/windsurf/index.ts";
import { writeAnthropicResponse } from "./ingress/anthropic_encode.ts";
import { readAnthropicMessagesRequest } from "./ingress/anthropic_messages.ts";
import { readChatCompletionsRequest } from "./ingress/openai_chat_completions.ts";
import { writeChatCompletionsResponse, writeResponsesResponse } from "./ingress/openai_encode.ts";
import { readResponsesRequest } from "./ingress/openai_responses.ts";
import type {
  IROutboxDescriptor, IROutboxRegistry, IRIngressCodec, IRIngressRegistry,
} from "./ir/codec.ts";
import { IR_PROTOCOLS, type IRProtocol } from "./ir/types.ts";

// ── 入口：封闭集，三个 ──────────────────────────────────────────────────────

const anthropicMessages: IRIngressCodec = {
  protocol: "anthropic_messages",
  readClientRequest: readAnthropicMessagesRequest,
  writeClientResponse: writeAnthropicResponse,
};

const openaiResponses: IRIngressCodec = {
  protocol: "openai_responses",
  readClientRequest: readResponsesRequest,
  writeClientResponse: writeResponsesResponse,
};

const openaiChatCompletions: IRIngressCodec = {
  protocol: "openai_chat_completions",
  readClientRequest: readChatCompletionsRequest,
  writeClientResponse: writeChatCompletionsResponse,
};

export const INGRESS_CODECS = {
  anthropic_messages: anthropicMessages,
  openai_responses: openaiResponses,
  openai_chat_completions: openaiChatCompletions,
} as const satisfies IRIngressRegistry;

/**
 * 协议 → HTTP 入口路径。**唯一授权的那一份**，键由 `IRProtocol` 穷举：
 * 新增一个协议却不给它路径，这里当场编译失败，而不是上线后发现那个端点 404。
 *
 * 方向是「协议 → 路径」而不是反过来，正因为只有这个方向的键能被类型穷举。
 */
export const INGRESS_PATH_BY_PROTOCOL = {
  anthropic_messages: "/v1/messages",
  openai_responses: "/v1/responses",
  openai_chat_completions: "/v1/chat/completions",
} as const satisfies Record<IRProtocol, string>;

/**
 * 路径 → 协议，供 server 路由查表。**由上表机械反转得到，不是第二份表。**
 *
 * 反转唯一挡不住的漂移是「两个协议填了同一个路径」——那会让其中一个协议静默不可达。
 * 类型系统表达不了这个（值相等不可判），所以 codec_coverage 里有一条枚举两侧的往返测试兜它。
 */
export const INGRESS_PATHS: Readonly<Record<string, IRProtocol>> = Object.fromEntries(
  IR_PROTOCOLS.map((protocol) => [INGRESS_PATH_BY_PROTOCOL[protocol], protocol] as const),
);

// ── 出口：开放集，当前一家 ──────────────────────────────────────────────────

const anthropicOutbox: IROutboxDescriptor<AnthropicOutboxOptions> = {
  name: "anthropic",
  wire: "anthropic_messages_sse",
  create: createAnthropicOutbox,
};

const chatCompletionsOutbox: IROutboxDescriptor<OpenAIChatOutboxOptions> = {
  name: "openai_chat",
  wire: "openai_chat_completions_sse",
  create: createOpenAIChatOutbox,
};

const responsesOutbox: IROutboxDescriptor<OpenAIResponsesOutboxOptions> = {
  name: "openai_responses",
  wire: "openai_responses_sse",
  create: createOpenAIResponsesOutbox,
};

/**
 * Gemini via Google CloudCode。**不是任何客户端协议** —— 它只能当出口，
 * 这正是两条轴必须分开的实证：出口以供应商名为键，不以 IRProtocol 为键。
 */
const geminiCloudCodeOutbox: IROutboxDescriptor<GeminiCloudCodeOutboxOptions> = {
  name: "gemini_cloudcode",
  wire: "google_cloudcode_stream_generate_content_sse",
  create: createGeminiCloudCodeOutbox,
};

/**
 * Windsurf/Devin 的统一模型网关。模型家族由 `chat_model_uid` 选择，wire 始终是
 * ConnectRPC + Protobuf，因此它是一个出口而不是新的客户端入口协议。
 */
const windsurfOutbox: IROutboxDescriptor<WindsurfOutboxOptions, Uint8Array> = {
  name: "windsurf",
  wire: "connectrpc_protobuf_stream",
  create: createWindsurfOutbox,
};


/**
 * GitHub Copilot。**与 anthropic 共用同一份 Anthropic Messages 投影**（参数化的 dialect），
 * 差别只在鉴权头、每凭据自有的 base URL、以及能力边界 —— 后者按 606 条真实 Copilot
 * 归档流量的字段计数定，不是从「原生支持所以它也支持」类推来的。
 */
const copilotOutbox: IROutboxDescriptor<CopilotOutboxOptions> = {
  name: "copilot",
  wire: "anthropic_messages_sse",
  create: createCopilotOutbox,
};

export const OUTBOX_REGISTRY = {
  anthropic: anthropicOutbox,
  openai_chat: chatCompletionsOutbox,
  openai_responses: responsesOutbox,
  gemini_cloudcode: geminiCloudCodeOutbox,
  windsurf: windsurfOutbox,
  copilot: copilotOutbox,
} as const satisfies IROutboxRegistry;

export {
  anthropicOutbox, anthropicMessages, chatCompletionsOutbox, geminiCloudCodeOutbox,
  openaiChatCompletions, openaiResponses, copilotOutbox, responsesOutbox, windsurfOutbox,
};
export {
  createAnthropicOutbox, createOpenAIChatOutbox,
  createGeminiCloudCodeOutbox, createOpenAIResponsesOutbox, createWindsurfOutbox,
};
