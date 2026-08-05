/**
 * 本地网关：三个入口端点 → IR → **配置选定的**出口。
 *
 * 这个文件是**组合根**，不是策略所在地：读一份配置（`src/gateway/config.ts`）装配出
 * 全部依赖，然后把它们交给一个纯粹的请求处理函数。除了 `readGatewayRuntimeSettings(process.env)`
 * 这一处，本文件任何函数体都不再伸手去拿环境变量或全局单例 ——
 * 需要什么由 `createGatewayRequestResponder` 的参数说清楚。
 *
 * 一次请求的裁决链（每一步都在 debug 级别留一条结构化记录，同一个 trace 串起来就是全链）：
 *   inbox_received → inbox_decoded → model_routed → repair_applied → admission_decided
 *   → outbox_written → outbox_responded → outbox_response_read(unhandled 计数) → inbox_response_encoded
 * 排查协议问题不需要客户端配合带任何 debug 头 —— 真实客户端注入不了自定义头，
 * 这是上一轮踩过的坑。
 */
import { randomUUID } from "node:crypto";
import { describeUnsupportedCapabilities } from "./ir/admission.ts";
import { deriveCapabilityNeeds } from "./ir/capabilities.ts";
import {
  createIRMessageInterceptionExtensions, IRRequestInterceptionRejected,
  type IRMessageInterceptionExtensions, type MutableIRRequest,
} from "./ir/ir_message_interception_extensions.ts";
import { superviseUpstreamStream } from "./ir/stream_guard.ts";
import { createLogger, type Logger } from "./obs/log.ts";
import { readClientRequestForProtocol } from "./inbox/index.ts";
import { INBOX_CODECS, INBOX_PATHS } from "./protocols.ts";
import { describeRepairsAsLosses, repairForAdmission } from "./repair/index.ts";
import { readGatewayRuntimeSettings, type GatewayRuntimeSettings } from "./gateway/config.ts";
import { GatewaySettingsError, type EnvLookup } from "./gateway/env.ts";
import { describeUnroutedModel, resolveOutboxModel } from "./gateway/model_routing.ts";
import { describeProblemWithRepairAdvice } from "./gateway/repair_advice.ts";
import type { IREvent, IRLoss, IRProtocol, IRRequest } from "./ir/types.ts";

// ── 组合根 ──────────────────────────────────────────────────────────────────

/**
 * 配置不合法就**不要起进程**。
 *
 * 用干净的一行 stderr 而不是让异常冒到顶：运维看到的第一屏应该是「哪个变量错了、
 * 合法取值有哪些」，不是一段栈。这也是「静默回退到默认出口」的反面 ——
 * 那种形态会让人以为路由生效了。
 */
function loadConfigOrExit(env: EnvLookup): GatewayRuntimeSettings {
  try {
    return readGatewayRuntimeSettings(env);
  } catch (error) {
    const detail = error instanceof GatewaySettingsError || error instanceof Error
      ? error.message
      : String(error);
    process.stderr.write(`agent-ir: refusing to start — invalid gateway configuration\n  ${detail}\n`);
    process.exit(1);
  }
}

// ── 日志辅助 ────────────────────────────────────────────────────────────────

function logLosses(log: Logger, traceId: string, stage: string, losses: readonly IRLoss[]): void {
  if (losses.length === 0) return;
  // 有损是设计信息，不是错误：warn 而非 error，且必须逐条可见，不折叠成计数。
  log.warn({
    event: "ir_loss_recorded", trace: traceId, stage,
    losses: losses.map((loss) => ({ path: loss.path, kind: loss.kind, outbox: loss.outbox, detail: loss.detail })),
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

function errorResponse(type: string, message: string, status: number): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

// ── 请求处理 ────────────────────────────────────────────────────────────────

export function createGatewayRequestResponder(
  config: GatewayRuntimeSettings,
  log: Logger,
  irMessageInterceptionExtensions: IRMessageInterceptionExtensions = createIRMessageInterceptionExtensions(),
): (request: Request) => Promise<Response> {
  // 启用了哪几条修复，拒绝信息里要据此只建议**还没开的**那几条。
  const enabledRepairs = new Set(config.repairKinds);

  return async function respondToInboxRequest(httpRequest: Request): Promise<Response> {
    const url = new URL(httpRequest.url);
    const protocol: IRProtocol | undefined = INBOX_PATHS[url.pathname];

    if (url.pathname === "/readyz") return new Response("ok");
    if (protocol === undefined) {
      return errorResponse("not_found_error", `unknown path ${url.pathname}`, 404);
    }
    if (httpRequest.method !== "POST") {
      return errorResponse("invalid_request_error", "method not allowed", 405);
    }

    const traceId = `ir-${randomUUID().replaceAll("-", "")}`;
    const started = performance.now();

    let raw: unknown;
    try {
      raw = await httpRequest.json();
    } catch (error) {
      log.warn({ event: "inbox_body_unparsable", trace: traceId, protocol, error });
      return errorResponse("invalid_request_error", "request body is not valid JSON", 400);
    }

    if (log.isLevelEnabled("debug")) {
      log.debug({
        event: "inbox_received", trace: traceId, protocol, path: url.pathname,
        body_bytes: JSON.stringify(raw).length,
      });
    }

    let decoded;
    try {
      decoded = readClientRequestForProtocol(protocol, raw, traceId);
    } catch (error) {
      log.warn({ event: "inbox_decode_failed", trace: traceId, protocol, error });
      return errorResponse("invalid_request_error", "request could not be decoded", 400);
    }
    const clientRequest = decoded.request as MutableIRRequest;
    try {
      await irMessageInterceptionExtensions.inboxRequestInterceptorChain.executeInterceptors(clientRequest, { traceId, protocol });
    } catch (error) {
      if (error instanceof IRRequestInterceptionRejected) {
        log.warn({ event: "request_interceptor_rejected", trace: traceId, protocol, code: error.code });
        return errorResponse(error.code, error.message, error.status);
      }
      throw error;
    }
    // `requires` 是 conversation/intent 的函数，不允许 inbox interceptor 改了内容却沿用解码前的能力集。
    clientRequest.requires = deriveCapabilityNeeds(clientRequest) as MutableIRRequest["requires"];
    logLosses(log, traceId, "inbox", decoded.losses);
    log.debug({ event: "inbox_decoded", trace: traceId, protocol, ...summarizeRequest(clientRequest) });

    // ── 模型映射：客户端说的名字 → 这家上游签发的 id ──────────────────────
    const routed = resolveOutboxModel(config.models, clientRequest.model);
    if (routed.kind === "unrouted") {
      log.warn({
        event: "model_unrouted", trace: traceId, outbox: config.outbox.name,
        client_model: clientRequest.model, known: routed.knownClientModels,
      });
      // 404 而不是 422：请求本身合法、这个出口也未必承载不了它，是**这台网关不认识
      // 这个模型名**。语义与上游对未知 model 的答复一致，客户端能照常处理。
      return errorResponse("not_found_error", describeUnroutedModel(routed), 404);
    }
    const outboxModel = routed.outboxModel;
    log.debug({
      event: "model_routed", trace: traceId, outbox: config.outbox.name,
      client_model: clientRequest.model, outbox_model: outboxModel, via: routed.via,
    });

    const outbox = config.outbox.resolve(outboxModel);

    // ── 修复（默认一条都不修）→ 准入 ─────────────────────────────────────
    // 修复会改变 `requires`，所以修完必须重新裁决 —— `repairForAdmission` 把这两步绑在一起，
    // 调用方漏不掉。策略为空时 `request` 就是入参那个对象本身，确定性是默认值。
    const repaired = repairForAdmission(clientRequest, outbox.profile, config.repairPolicy, config.outbox.name);
    if (repaired.applied.length > 0) {
      log.debug({
        event: "repair_applied", trace: traceId, outbox: config.outbox.name,
        kinds: repaired.applied.map((record) => record.kind),
      });
      logLosses(log, traceId, "repair", describeRepairsAsLosses(repaired.applied, config.outbox.name));
    }
    const request = repaired.request;

    const verdict = repaired.admission;
    logLosses(log, traceId, "admission", verdict.losses);
    log.debug({
      event: "admission_decided", trace: traceId, outbox: config.outbox.name,
      admitted: verdict.admitted,
      unsupported: verdict.unsupported.map((need) => need.capability),
    });
    if (!verdict.admitted) {
      // 422 而不是 400：请求本身合法，是这个出口表达不了它。路径精确到 IR 位置。
      return errorResponse(
        "invalid_request_error",
        `outbox '${config.outbox.name}' cannot carry: ${describeUnsupportedCapabilities(verdict.unsupported)}`,
        422,
      );
    }

    // ── 编译出站请求 ──────────────────────────────────────────────────────
    const lowered = await outbox.writeOutboxRequest(request);
    logLosses(log, traceId, "outbox", lowered.losses);
    if (!lowered.ok) {
      // Core 不发明内容：表达不了就带精确 IR 路径拒绝，绝不发一个非法 body。
      // 拒绝信息里同时给出「开哪条 repair 能修它」—— 这张映射住在 server 层（见
      // gateway/repair_advice.ts），Core 对 repair 的枚举一无所知。
      log.warn({
        event: "outbox_refused", trace: traceId, outbox: config.outbox.name,
        problems: lowered.problems.map((problem) => ({ kind: problem.kind, path: problem.path, detail: problem.detail })),
      });
      return errorResponse(
        "invalid_request_error",
        `outbox '${config.outbox.name}' cannot carry: `
          + lowered.problems.map((problem) => describeProblemWithRepairAdvice(problem, enabledRepairs)).join("; "),
        422,
      );
    }
    log.debug({
      event: "outbox_lowered", trace: traceId, outbox: config.outbox.name,
      outbox_model: outboxModel, url: lowered.wire.url, body_bytes: lowered.wire.body.length,
    });
    if (log.isLevelEnabled("trace")) {
      log.trace({ event: "outbox_wire_body", trace: traceId, body: lowered.wire.body });
    }

    let outboxResponse: Response;
    try {
      // `body` 是 `string | Uint8Array`：文本 wire 与 protobuf wire 走同一行，
      // 传输层不做任何协议特判，二进制也绝不 base64 化。
      outboxResponse = await fetch(lowered.wire.url, {
        method: lowered.wire.method,
        headers: lowered.wire.headers,
        body: lowered.wire.body,
        signal: httpRequest.signal,
      });
    } catch (error) {
      log.error({ event: "outbox_transport_failed", trace: traceId, error });
      return errorResponse("api_error", "The upstream connection failed.", 502);
    }
    log.debug({
      event: "outbox_responded", trace: traceId, status: outboxResponse.status,
      content_type: outboxResponse.headers.get("content-type"),
      elapsed_ms: Math.round(performance.now() - started),
    });

    let unhandledCount = 0;
    const onUnhandled = (rawType: string, payload: unknown): void => {
      unhandledCount += 1;
      // 上游协议漂移在这里自己冒头，不用等故障反推。
      log.warn({ event: "outbox_event_unhandled", trace: traceId, raw_type: rawType, raw: payload });
    };

    // 流守卫夹在**读回**与**出站编码**之间，顺序不能反：
    //   - 它在 `readOutboxResponse` 之上，所以 `unhandled` 这类事件也算「上游有进展」，
    //     不会被误判成静默（下面那层观察器会把 unhandled 过滤掉，若守卫在外侧就看不见它们）；
    //   - 它在 encoder 之下，所以注入的 `committed` / `heartbeat` 会被各协议的 encoder
    //     渲染成自己的保活帧（Anthropic 的 ping、OpenAI 的 SSE 注释）。
    // 策略从配置来，默认值原样是 `DEFAULT_STREAM_POLICY`（生产标定值）。
    const guarded = superviseUpstreamStream(
      outbox.readOutboxResponse(outboxResponse, {
        inspectCompleteSseFrame: (frame) => irMessageInterceptionExtensions.outboxSseFrameInterceptorChain.executeInterceptors(frame, {
          traceId, protocol, outbox: config.outbox.name, stream: clientRequest.intent.stream.value,
        }),
      }),
      config.streamPolicy,
    );

    async function* observed(): AsyncGenerator<IREvent> {
      for await (const event of guarded) {
        if (event.kind === "unhandled") { onUnhandled(event.rawType, event.raw); continue; }
        if (event.kind === "error") {
          log.warn({ event: "outbox_response_error", trace: traceId, error_kind: event.error.kind, http_status: event.error.httpStatus, message: event.error.message });
        }
        if (log.isLevelEnabled("trace")) log.trace({ event: "ir_event", trace: traceId, ir_event: event });
        yield event;
      }
      log.debug({
        event: "outbox_response_read", trace: traceId,
        unhandled: unhandledCount, elapsed_ms: Math.round(performance.now() - started),
      });
    }

    // 出站编码按**入口协议**分发：客户端说哪种协议就回哪种，与上游用什么无关。
    // 查注册表而不是写 if 链：旧的三元链最后一档是兜底分支，新增协议会被静默塞进 Responses 编码器；
    // `INBOX_CODECS` 的键由 IRProtocol 穷举，漏一个协议在 protocols.ts 就编译失败。
    //
    // 交给 encoder 的是**客户端那份请求**而不是修复后的：响应是写给客户端看的，
    // 里面回显的 model 必须是他自己说的那个名字。
    const encodeOptions = {
      messageId: `msg_${traceId}`, onUnhandled,
      runCompleteIRResponseInterception: (response: Parameters<IRMessageInterceptionExtensions["inboxCompletedResponseInterceptorChain"]["executeInterceptors"]>[0]) =>
        irMessageInterceptionExtensions.inboxCompletedResponseInterceptorChain.executeInterceptors(response, {
          traceId, protocol, outbox: config.outbox.name, stream: clientRequest.intent.stream.value,
        }),
    };
    const response = await INBOX_CODECS[protocol].writeClientResponse(observed(), clientRequest, encodeOptions);
    log.info({
      event: "inbox_response_completed", trace: traceId, protocol, status: response.status,
      stream: clientRequest.intent.stream.value, elapsed_ms: Math.round(performance.now() - started),
    });
    return response;
  };
}

// ── 启动 ────────────────────────────────────────────────────────────────────

/**
 * 可嵌入的默认网关启动器。把启动挪到 `main.ts` 后，库用户可安全 import
 * `createGatewayRequestResponder` / `createIRMessageInterceptionExtensions`，并把 interceptor 注册在真实请求路径上。
 */
export function startGateway(
  env: EnvLookup = process.env,
  irMessageInterceptionExtensions: IRMessageInterceptionExtensions = createIRMessageInterceptionExtensions(),
): ReturnType<typeof Bun.serve> {
  const config = loadConfigOrExit(env);
  const log = createLogger(config.logging).child({ component: "gateway" });
  const respondToHttpRequest = createGatewayRequestResponder(config, log, irMessageInterceptionExtensions);
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 240,
    fetch: (request) => respondToHttpRequest(request).catch((error: unknown) => {
      log.error({ event: "gateway_unhandled_exception", error });
      return errorResponse("api_error", "internal gateway error", 500);
    }),
  });

  log.info({
    event: "gateway_started", port: config.port,
    outbox: config.outbox.name, wire: config.outbox.wire,
    models: Object.fromEntries(config.models.routes),
    model_fallback: config.models.fallback.kind,
    repair_kinds: config.repairKinds,
    stream_policy: config.streamPolicy,
    endpoints: Object.keys(INBOX_PATHS),
  });
  return server;
}
