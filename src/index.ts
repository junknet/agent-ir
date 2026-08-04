/**
 * Core IR 的唯一公共入口。
 *
 * 消费者只从这里 import；`src/ir/**`、`src/ingress/**`、`src/egress/**` 是内部结构，
 * 允许重排而不惊动调用方。需要 Windsurf 出口时另走 `agent-ir/egress/windsurf` 子路径 ——
 * 它要 protobuf 运行时依赖，不能污染零依赖的 core。
 */
export * from "./ir/types.ts";
export * from "./ir/codec.ts";
export * from "./ir/response.ts";
export * from "./ir/admission.ts";
export * from "./ir/capabilities.ts";
export * from "./ir/stream_guard.ts";
export { iterateSse, formatSse, tryParseJson, type SseEvent } from "./ir/sse.ts";
export {
  EGRESS_PROVIDERS, INGRESS_CODECS, INGRESS_PATHS, INGRESS_PATH_BY_PROTOCOL,
} from "./protocols.ts";
