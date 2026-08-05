/**
 * IREvent 流 → Anthropic Messages 出站响应（SSE 或一次性 JSON）。
 *
 * 两条路径共用同一个事件流：流式直接转发帧，非流式在内存里聚合成一个 Message。
 * 「非流式」不是另一套解析，只是同一个流的收敛 —— 这样两条路径不会长出两种行为。
 */
import { formatSse } from "../ir/sse.ts";
import {
  observeCompleteIRResponseBeforeStreamTermination, processCompleteIRResponse,
} from "../ir/ir_message_interception_extensions.ts";
import type { IREvent, IRRequest, IRResponsePart, IRStopReason, IRUsage } from "../ir/types.ts";
import { asResponsePart, assembleResponse } from "../ir/response.ts";
import type { EncodeOptions } from "./shared.ts";

const STOP_REASON_WIRE: Record<IRStopReason, string> = {
  endTurn: "end_turn", maxTokens: "max_tokens", stopSequence: "stop_sequence",
  toolUse: "tool_use", refusal: "refusal", aborted: "end_turn", error: "end_turn",
};

/** 下发错误文案只从这里取，上游原文不进出站字节。 */
function discloseError(event: Extract<IREvent, { kind: "error" }>): { type: string; message: string; status: number } {
  switch (event.error.kind) {
    case "invalidRequest": return { type: "invalid_request_error", message: "The request is not valid for this model.", status: 400 };
    case "permissionDenied": return { type: "permission_error", message: "The upstream account is not permitted to serve this request.", status: 403 };
    case "rateLimited": return { type: "rate_limit_error", message: "Rate limited upstream; retry later.", status: 429 };
    case "quotaExhausted": return { type: "rate_limit_error", message: "Upstream quota exhausted.", status: 429 };
    case "contextLengthExceeded": return { type: "invalid_request_error", message: "The conversation exceeds the model context window.", status: 400 };
    case "contentPolicy": return { type: "invalid_request_error", message: "The request was rejected by an upstream content policy.", status: 400 };
    case "upstreamUnavailable": return { type: "overloaded_error", message: "Upstream is temporarily unavailable.", status: 503 };
    case "transport": return { type: "api_error", message: "The upstream connection failed before completion.", status: 502 };
    case "unknown": return { type: "api_error", message: "The upstream request failed.", status: 502 };
  }
}

// IRResponsePart → Anthropic wire 块。**全函数**：收窄由 asResponsePart 一处负责，
// 这里不再需要 `return null` 兜底 —— 那种兜底写几遍就漏几遍。
function responsePartToBlock(part: IRResponsePart): Record<string, unknown> {
  switch (part.kind) {
    case "text": return { type: "text", text: part.text };
    case "thinking": return { type: "thinking", thinking: part.text, ...(part.signature === undefined ? {} : { signature: part.signature }) };
    case "redactedThinking": return { type: "redacted_thinking", data: part.data };
    case "toolCall": return {
      type: "tool_use", id: part.call.id, name: part.call.toolRef.name,
      input: part.call.input.kind === "json" ? part.call.input.value : { input: part.call.input.text },
    };
  }
}

function usageWire(usage: IRUsage | null): Record<string, number> {
  if (usage === null) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    // 缺省即「上游不支持缓存」，恒定写 0 会让下游分不清它和「这轮没命中」。
    ...(usage.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: usage.cacheWriteTokens }),
  };
}

export function writeAnthropicResponse(
  events: AsyncIterable<IREvent>,
  request: IRRequest,
  options: EncodeOptions,
): Response | Promise<Response> {
  return request.intent.stream.value
    ? encodeStream(
      options.processCompleteIRResponse === undefined ? events
        : observeCompleteIRResponseBeforeStreamTermination(events, request.model, options.processCompleteIRResponse),
      request,
      options,
    )
    : encodeAggregate(events, request, options);
}

function encodeStream(events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(formatSse(event, data)));
      };
      let started = false;
      let stopped = false;
      let usage: IRUsage | null = null;

      const ensureStart = (model: string): void => {
        if (started) return;
        started = true;
        send("message_start", {
          type: "message_start",
          message: {
            id: options.messageId, type: "message", role: "assistant", model,
            content: [], stop_reason: null, stop_sequence: null, usage: usageWire(null),
          },
        });
      };

      try {
        for await (const event of events) {
          switch (event.kind) {
            case "messageStart":
              ensureStart(event.model.length > 0 ? event.model : request.model);
              break;

            case "partStart": {
              ensureStart(request.model);
              const responsePart = asResponsePart(event.part);
              if (responsePart === null) { options.onUnhandled?.("response_part", event.part); break; }
              send("content_block_start", { type: "content_block_start", index: event.index, content_block: responsePartToBlock(responsePart) });
              break;
            }

            case "partDelta": {
              ensureStart(request.model);
              const delta =
                event.delta.kind === "text" ? { type: "text_delta", text: event.delta.text }
                : event.delta.kind === "thinking" ? { type: "thinking_delta", thinking: event.delta.text }
                : event.delta.kind === "thinkingSignature" ? { type: "signature_delta", signature: event.delta.signature }
                : event.delta.kind === "toolInputJson" ? { type: "input_json_delta", partial_json: event.delta.json }
                : { type: "input_json_delta", partial_json: JSON.stringify({ input: event.delta.text }) };
              send("content_block_delta", { type: "content_block_delta", index: event.index, delta });
              break;
            }

            case "partEnd":
              send("content_block_stop", { type: "content_block_stop", index: event.index });
              break;

            case "usage":
              usage = event.usage;
              break;

            case "messageStop":
              ensureStart(request.model);
              stopped = true;
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: STOP_REASON_WIRE[event.reason], stop_sequence: null },
                usage: usageWire(usage),
              });
              send("message_stop", { type: "message_stop" });
              break;

            case "error": {
              const disclosed = discloseError(event);
              // 已提交（首帧已下发）之后不能改状态码，只能在 200 流里补一个规范内的 error 事件。
              if (!started) ensureStart(request.model);
              send("error", { type: "error", error: { type: disclosed.type, message: disclosed.message } });
              stopped = true;
              break;
            }

            case "committed":
              break;

            case "heartbeat":
              // Anthropic 协议内的合法保活帧。生产实证：CF 计的是数据间隔，
              // 静默 125.8 秒即被掐成 524，下游拿到的是纯文本错误页。
              ensureStart(request.model);
              send("ping", { type: "ping" });
              break;

            case "loss":
              // 有损只进日志与遥测，不进出站字节。
              break;

            case "unhandled":
              options.onUnhandled?.(event.rawType, event.raw);
              break;
          }
        }
        if (!stopped) {
          ensureStart(request.model);
          send("error", { type: "error", error: { type: "api_error", message: "The upstream connection failed before completion." } });
        }
      } catch (error) {
        if (!started) ensureStart(request.model);
        options.onUnhandled?.("encode_exception", error);
        send("error", { type: "error", error: { type: "api_error", message: "The upstream connection failed before completion." } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function encodeAggregate(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Promise<Response> {
  // 折叠只有一个实现（ir/response.ts）。此处只做 IRResponse → Anthropic wire 的映射，
  // 不再自己维护一份累积状态 —— 那样两个协议会各折各的，且都落不到 IR 上。
  const assembled = await assembleResponse(events, request.model);
  await processCompleteIRResponse(assembled, options.processCompleteIRResponse);
  for (const event of assembled.unhandled) options.onUnhandled?.(event.rawType, event.raw);

  if (assembled.error !== null) {
    const disclosed = discloseError({ kind: "error", error: assembled.error });
    return Response.json(
      { type: "error", error: { type: disclosed.type, message: disclosed.message } },
      { status: disclosed.status },
    );
  }
  if (assembled.stopReason === null) {
    // 没有终止事件 = 上游中途断了。返回真实错误，绝不回一个「200 但空」的假成功。
    return Response.json(
      { type: "error", error: { type: "api_error", message: "The upstream connection failed before completion." } },
      { status: 502 },
    );
  }

  return Response.json({
    id: options.messageId,
    type: "message",
    role: "assistant",
    model: assembled.model,
    content: assembled.turn.parts.map(responsePartToBlock),
    stop_reason: STOP_REASON_WIRE[assembled.stopReason],
    stop_sequence: null,
    usage: usageWire(assembled.usage),
  });
}
