/**
 * Core IR 的唯一公共入口。
 *
 * 消费者只从这里 import；`src/ir/**`、`src/ingress/**`、`src/egress/**` 是内部结构，
 * 允许重排而不惊动调用方。Windsurf 的 Protobuf 出口另提供
 * `agent-ir/egress/windsurf` 子路径，供只需该出口的消费者直接依赖。
 */
export * from "./ir/types.ts";
export * from "./ir/codec.ts";
export * from "./ir/response.ts";
export * from "./ir/ir_message_interception_extensions.ts";
export { createRequestHandler, startGateway } from "./server.ts";
export * from "./ir/admission.ts";
export * from "./ir/capabilities.ts";
export * from "./ir/stream_guard.ts";
export { iterateSse, formatSse, tryParseJson, type SseEvent } from "./ir/sse.ts";
export {
  EGRESS_PROVIDERS, INGRESS_CODECS, INGRESS_PATHS, INGRESS_PATH_BY_PROTOCOL,
} from "./protocols.ts";
export {
  createAnthropicUpstream,
  createGeminiCloudCodeUpstream,
  createChatCompletionsUpstream,
  createResponsesUpstream,
  createWindsurfUpstream,
} from "./protocols.ts";
