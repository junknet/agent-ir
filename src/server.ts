/**
 * 本地网关：三个入口端点 → IR → 单一出口。
 *
 * 每个阶段都在 debug 级别留一条结构化记录，同一个 trace 串起来就是完整决策链：
 *   ingress_received → ingress_decoded → admission_decided → egress_lowered
 *   → upstream_responded → egress_lifted(unhandled 计数) → response_encoded
 * 排查协议问题不需要客户端配合带任何 debug 头 —— 真实客户端注入不了自定义头，
 * 这是上一轮踩过的坑。
 */
import { randomUUID } from "node:crypto";
import { createAnthropicUpstream } from "./egress/anthropic.ts";
import { checkUpstreamSupport, describeUnsupportedCapabilities } from "./ir/admission.ts";
import { configureLogging, getLogger, jsonSink, parseLogLevel, textSink } from "./obs/log.ts";
import { readClientRequestForProtocol } from "./ingress/index.ts";
import { INGRESS_CODECS, INGRESS_PATHS } from "./protocols.ts";
import type { IREgress, IREvent, IRLoss, IRProtocol, IRRequest } from "./ir/types.ts";

const DEV = (process.env.AGENT_IR_ENV ?? "dev") === "dev";

configureLogging({
  level: parseLogLevel(process.env.AGENT_IR_LOG_LEVEL, DEV ? "debug" : "info"),
  service: process.env.AGENT_IR_SERVICE ?? "agent-ir",
  sink: (process.env.AGENT_IR_LOG_FORMAT ?? (DEV ? "text" : "json")) === "text" ? textSink() : jsonSink(),
});

const log = getLogger("gateway");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing required environment variable ${name}`);
  return value;
}

const egress: IREgress = createAnthropicUpstream({
  baseUrl: requiredEnv("AGENT_IR_UPSTREAM_BASE_URL"),
  apiKey: requiredEnv("AGENT_IR_UPSTREAM_API_KEY"),
  model: process.env.AGENT_IR_UPSTREAM_MODEL ?? "claude-opus-5",
});

function logLosses(traceId: string, stage: string, losses: readonly IRLoss[]): void {
  if (losses.length === 0) return;
  // 有损是设计信息，不是错误：warn 而非 error，且必须逐条可见，不折叠成计数。
  log.warn({
    event: "ir_loss_recorded", trace: traceId, stage,
    losses: losses.map((loss) => ({ path: loss.path, kind: loss.kind, provider: loss.provider, detail: loss.detail })),
  });
}

function summarizeRequest(request: IRRequest): Record<string, unknown> {
  const partKinds = new Map<string, number>();
  const count = (kind: string): void => { partKinds.set(kind, (partKinds.get(kind) ?? 0) + 1); };
  for (const part of request.conversation.system) count(`system:${part.kind}`);
  for (const turn of request.conversation.turns) for (const part of turn.parts) count(`${turn.role}:${part.kind}`);
  return {
    model: request.model,
    system_parts: request.conversation.system.length,
    turns: request.conversation.turns.length,
    part_kinds: Object.fromEntries(partKinds),
    tools: request.conversation.toolset.tools.length,
    tool_groups: request.conversation.toolset.groups.length,
    reasoning: request.intent.reasoning.value,
    reasoning_source: request.intent.reasoning.source,
    output_format: request.intent.outputFormat.value.kind,
    max_output_tokens: request.intent.stopping.maxOutputTokens?.value ?? null,
    stream: request.intent.stream.value,
    context_edits: request.intent.contextEdits.length,
    identity: request.intent.identity,
    requires: request.requires.map((need) => need.capability),
  };
}

async function handle(httpRequest: Request): Promise<Response> {
  const url = new URL(httpRequest.url);
  const protocol: IRProtocol | undefined = INGRESS_PATHS[url.pathname];

  if (url.pathname === "/readyz") return new Response("ok");
  if (protocol === undefined) {
    return Response.json({ type: "error", error: { type: "not_found_error", message: `unknown path ${url.pathname}` } }, { status: 404 });
  }
  if (httpRequest.method !== "POST") {
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "method not allowed" } }, { status: 405 });
  }

  const traceId = `ir-${randomUUID().replaceAll("-", "")}`;
  const started = performance.now();

  let raw: unknown;
  try {
    raw = await httpRequest.json();
  } catch (error) {
    log.warn({ event: "ingress_body_unparsable", trace: traceId, protocol, error });
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "request body is not valid JSON" } }, { status: 400 });
  }

  log.debug({
    event: "ingress_received", trace: traceId, protocol, path: url.pathname,
    body_bytes: JSON.stringify(raw).length,
  });

  let decoded;
  try {
    decoded = readClientRequestForProtocol(protocol, raw, traceId);
  } catch (error) {
    log.warn({ event: "ingress_decode_failed", trace: traceId, protocol, error });
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "request could not be decoded" } }, { status: 400 });
  }
  const { request } = decoded;
  logLosses(traceId, "ingress", decoded.losses);
  log.debug({ event: "ingress_decoded", trace: traceId, protocol, ...summarizeRequest(request) });

  const verdict = checkUpstreamSupport(request, egress.profile);
  logLosses(traceId, "admission", verdict.losses);
  log.debug({
    event: "admission_decided", trace: traceId, provider: egress.profile.provider,
    admitted: verdict.admitted,
    unsupported: verdict.unsupported.map((need) => need.capability),
  });
  if (!verdict.admitted) {
    // 422 而不是 400：请求本身合法，是这个出口表达不了它。路径精确到 IR 位置。
    return Response.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `upstream '${egress.profile.provider}' cannot carry: ${describeUnsupportedCapabilities(verdict.unsupported)}`,
      },
    }, { status: 422 });
  }

  const lowered = await egress.writeUpstreamRequest(request);
  logLosses(traceId, "egress", lowered.losses);
  log.debug({
    event: "egress_lowered", trace: traceId, provider: egress.profile.provider,
    url: lowered.wire.url, body_bytes: lowered.wire.body.length,
  });
  if (log.enabled("trace")) {
    log.trace({ event: "egress_wire_body", trace: traceId, body: lowered.wire.body });
  }

  let upstream: Response;
  try {
    upstream = await fetch(lowered.wire.url, {
      method: lowered.wire.method,
      headers: lowered.wire.headers,
      body: lowered.wire.body,
      signal: httpRequest.signal,
    });
  } catch (error) {
    log.error({ event: "upstream_transport_failed", trace: traceId, error });
    return Response.json({ type: "error", error: { type: "api_error", message: "The upstream connection failed." } }, { status: 502 });
  }
  log.debug({
    event: "upstream_responded", trace: traceId, status: upstream.status,
    content_type: upstream.headers.get("content-type"),
    elapsed_ms: Math.round(performance.now() - started),
  });

  let unhandledCount = 0;
  const onUnhandled = (rawType: string, payload: unknown): void => {
    unhandledCount += 1;
    // 上游协议漂移在这里自己冒头，不用等故障反推。
    log.warn({ event: "upstream_event_unhandled", trace: traceId, raw_type: rawType, raw: payload });
  };

  async function* observed(): AsyncGenerator<IREvent> {
    for await (const event of egress.readUpstreamResponse(upstream)) {
      if (event.kind === "unhandled") { onUnhandled(event.rawType, event.raw); continue; }
      if (event.kind === "error") {
        log.warn({ event: "upstream_error_lifted", trace: traceId, error_kind: event.error.kind, http_status: event.error.httpStatus, message: event.error.message });
      }
      if (log.enabled("trace")) log.trace({ event: "ir_event", trace: traceId, ir_event: event });
      yield event;
    }
    log.debug({
      event: "egress_lifted", trace: traceId,
      unhandled: unhandledCount, elapsed_ms: Math.round(performance.now() - started),
    });
  }

  // 出站编码按**入口协议**分发：客户端说哪种协议就回哪种，与上游用什么无关。
  // 查注册表而不是写 if 链：旧的三元链最后一档是兜底分支，新增协议会被静默塞进 Responses 编码器；
  // `INGRESS_CODECS` 的键由 IRProtocol 穷举，漏一个协议在 protocols.ts 就编译失败。
  const encodeOptions = { messageId: `msg_${traceId}`, onUnhandled };
  const response = await INGRESS_CODECS[protocol].writeClientResponse(observed(), request, encodeOptions);
  log.info({
    event: "request_completed", trace: traceId, protocol, status: response.status,
    stream: request.intent.stream.value, elapsed_ms: Math.round(performance.now() - started),
  });
  return response;
}

const port = Number(process.env.AGENT_IR_PORT ?? 9797);
Bun.serve({
  port,
  idleTimeout: 240,
  fetch: (request) => handle(request).catch((error: unknown) => {
    log.error({ event: "gateway_unhandled_exception", error });
    return Response.json({ type: "error", error: { type: "api_error", message: "internal gateway error" } }, { status: 500 });
  }),
});

log.info({
  event: "gateway_started", port,
  upstream: egress.profile.provider,
  model: process.env.AGENT_IR_UPSTREAM_MODEL ?? "claude-opus-5",
  endpoints: Object.keys(INGRESS_PATHS),
});
