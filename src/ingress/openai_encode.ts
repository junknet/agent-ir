/**
 * IREvent 流 → OpenAI Chat Completions / Responses 出站响应。
 *
 * 两个协议共用同一个事件流与同一套错误披露，只在 wire 形状上分叉。
 * 关键不变量：**任何路径都不得产出「200 但空」的假成功** —— 上游中途失败必须以
 * 该协议自己的错误形态收尾（Chat 用 finish_reason + error chunk，Responses 用
 * response.failed），否则调用方无法区分「模型没话说」与「上游拒绝了」，只能盲重试。
 */
import { formatSse } from "../ir/sse.ts";
import type { IREvent, IRPart, IRRequest, IRStopReason, IRUsage } from "../ir/types.ts";
import type { EncodeOptions } from "./anthropic_encode.ts";

const CHAT_FINISH: Record<IRStopReason, string> = {
  endTurn: "stop", maxTokens: "length", stopSequence: "stop",
  toolUse: "tool_calls", refusal: "content_filter", aborted: "stop", error: "stop",
};

interface Disclosure { readonly type: string; readonly code: string; readonly message: string; readonly status: number }

function disclose(event: Extract<IREvent, { kind: "error" }>): Disclosure {
  switch (event.error.kind) {
    case "invalidRequest": return { type: "invalid_request_error", code: "invalid_request", message: "The request is not valid for this model.", status: 400 };
    case "permissionDenied": return { type: "invalid_request_error", code: "permission_denied", message: "The upstream account is not permitted to serve this request.", status: 403 };
    case "rateLimited": return { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limited upstream; retry later.", status: 429 };
    case "quotaExhausted": return { type: "insufficient_quota", code: "insufficient_quota", message: "Upstream quota exhausted.", status: 429 };
    case "contextLengthExceeded": return { type: "invalid_request_error", code: "context_length_exceeded", message: "The conversation exceeds the model context window.", status: 400 };
    case "contentPolicy": return { type: "invalid_request_error", code: "content_policy_violation", message: "The request was rejected by an upstream content policy.", status: 400 };
    case "upstreamUnavailable": return { type: "server_error", code: "server_error", message: "Upstream is temporarily unavailable.", status: 503 };
    case "transport": return { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion.", status: 502 };
    case "unknown": return { type: "server_error", code: "server_error", message: "The upstream request failed.", status: 502 };
  }
}

function usageWire(usage: IRUsage | null): Record<string, unknown> {
  if (usage === null) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
}

/** 累积器：两个协议的流式与非流式都从它取状态，避免四条路径长出四种行为。 */
class ResponseAccumulator {
  text = "";
  reasoning = "";
  readonly toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  readonly #toolIndexByPart = new Map<number, number>();
  usage: IRUsage | null = null;
  stopReason: IRStopReason | null = null;
  failure: Extract<IREvent, { kind: "error" }> | null = null;

  applyPartStart(index: number, part: IRPart): void {
    if (part.kind !== "toolCall") return;
    this.#toolIndexByPart.set(index, this.toolCalls.length);
    this.toolCalls.push({
      id: part.call.id,
      name: part.call.toolRef.group === null ? part.call.toolRef.name : `${part.call.toolRef.group}__${part.call.toolRef.name}`,
      arguments: part.call.input.kind === "json" && Object.keys(part.call.input.value).length > 0
        ? JSON.stringify(part.call.input.value)
        : part.call.input.kind === "text" ? part.call.input.text : "",
    });
  }

  applyDelta(index: number, delta: Extract<IREvent, { kind: "partDelta" }>["delta"]): void {
    if (delta.kind === "text") { this.text += delta.text; return; }
    if (delta.kind === "thinking") { this.reasoning += delta.text; return; }
    if (delta.kind === "thinkingSignature") return;
    const position = this.#toolIndexByPart.get(index);
    if (position === undefined) return;
    const call = this.toolCalls[position];
    if (call === undefined) return;
    call.arguments += delta.kind === "toolInputJson" ? delta.json : delta.text;
  }

  toolIndex(index: number): number | undefined {
    return this.#toolIndexByPart.get(index);
  }
}

async function consume(
  events: AsyncIterable<IREvent>,
  options: EncodeOptions,
  onEvent?: (event: IREvent, accumulator: ResponseAccumulator) => void,
): Promise<ResponseAccumulator> {
  const accumulator = new ResponseAccumulator();
  for await (const event of events) {
    switch (event.kind) {
      case "partStart": accumulator.applyPartStart(event.index, event.part); break;
      case "partDelta": accumulator.applyDelta(event.index, event.delta); break;
      case "usage": accumulator.usage = event.usage; break;
      case "messageStop": accumulator.stopReason = event.reason; break;
      case "error": accumulator.failure = event; break;
      case "unhandled": options.onUnhandled?.(event.rawType, event.raw); break;
      case "messageStart": case "partEnd": case "loss": break;
    }
    onEvent?.(event, accumulator);
  }
  return accumulator;
}

// ── Chat Completions ───────────────────────────────────────────────────────

export function encodeChatCompletionsResponse(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Response | Promise<Response> {
  return request.intent.stream.value
    ? encodeChatStream(events, request, options)
    : encodeChatAggregate(events, request, options);
}

function encodeChatStream(events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (delta: Record<string, unknown>, finishReason: string | null): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: options.messageId, object: "chat.completion.chunk", created, model: request.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`));
      };
      let finished = false;
      try {
        const accumulator = await consume(events, options, (event, state) => {
          switch (event.kind) {
            case "messageStart": push({ role: "assistant" }, null); break;
            case "partStart":
              if (event.part.kind !== "toolCall") break;
              push({ tool_calls: [{
                index: state.toolIndex(event.index) ?? 0, id: event.part.call.id, type: "function",
                function: { name: event.part.call.toolRef.name, arguments: "" },
              }] }, null);
              break;
            case "partDelta": {
              if (event.delta.kind === "text") { push({ content: event.delta.text }, null); break; }
              if (event.delta.kind === "thinking") { push({ reasoning_content: event.delta.text }, null); break; }
              if (event.delta.kind === "thinkingSignature") break;
              const position = state.toolIndex(event.index);
              if (position === undefined) break;
              push({ tool_calls: [{ index: position, function: { arguments: event.delta.kind === "toolInputJson" ? event.delta.json : event.delta.text } }] }, null);
              break;
            }
            default: break;
          }
        });

        if (accumulator.failure !== null) {
          const disclosed = disclose(accumulator.failure);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { type: disclosed.type, code: disclosed.code, message: disclosed.message } })}\n\n`));
          finished = true;
        } else if (accumulator.stopReason !== null) {
          push({}, CHAT_FINISH[accumulator.stopReason]);
          if (accumulator.usage !== null) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: options.messageId, object: "chat.completion.chunk", created, model: request.model,
              choices: [], usage: usageWire(accumulator.usage),
            })}\n\n`));
          }
          finished = true;
        }
      } catch (error) {
        options.onUnhandled?.("encode_exception", error);
      } finally {
        // 没有终止事件就必须显式报错，绝不让 [DONE] 单独收尾伪装成成功。
        if (!finished) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            error: { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion." },
          })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function encodeChatAggregate(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Promise<Response> {
  const state = await consume(events, options);
  if (state.failure !== null) {
    const disclosed = disclose(state.failure);
    return Response.json({ error: { type: disclosed.type, code: disclosed.code, message: disclosed.message } }, { status: disclosed.status });
  }
  if (state.stopReason === null) {
    return Response.json({
      error: { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion." },
    }, { status: 502 });
  }
  return Response.json({
    id: options.messageId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: request.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: state.text.length === 0 ? null : state.text,
        ...(state.reasoning.length === 0 ? {} : { reasoning_content: state.reasoning }),
        ...(state.toolCalls.length === 0 ? {} : {
          tool_calls: state.toolCalls.map((call) => ({
            id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
          })),
        }),
      },
      finish_reason: CHAT_FINISH[state.stopReason],
    }],
    usage: usageWire(state.usage),
  });
}

// ── Responses ──────────────────────────────────────────────────────────────

export function encodeResponsesResponse(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Response | Promise<Response> {
  return request.intent.stream.value
    ? encodeResponsesStream(events, request, options)
    : encodeResponsesAggregate(events, request, options);
}

function responsesOutput(state: ResponseAccumulator): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (state.reasoning.length > 0) {
    output.push({ type: "reasoning", id: `rs_${output.length}`, summary: [{ type: "summary_text", text: state.reasoning }] });
  }
  if (state.text.length > 0) {
    output.push({ type: "message", id: `msg_${output.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: state.text, annotations: [] }] });
  }
  for (const call of state.toolCalls) {
    output.push({ type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
  }
  return output;
}

function responsesEnvelope(
  state: ResponseAccumulator, request: IRRequest, options: EncodeOptions, status: string,
): Record<string, unknown> {
  return {
    id: options.messageId, object: "response", created_at: Math.floor(Date.now() / 1000),
    status, model: request.model, output: responsesOutput(state),
    usage: state.usage === null ? null : {
      input_tokens: state.usage.inputTokens, output_tokens: state.usage.outputTokens,
      total_tokens: state.usage.inputTokens + state.usage.outputTokens,
    },
  };
}

function encodeResponsesStream(events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => { controller.enqueue(encoder.encode(formatSse(event, data))); };
      let sequence = 0;
      const next = (): number => sequence++;
      let finished = false;
      try {
        send("response.created", { type: "response.created", sequence_number: next(), response: { id: options.messageId, object: "response", status: "in_progress", model: request.model, output: [] } });
        const state = await consume(events, options, (event) => {
          if (event.kind === "partDelta" && event.delta.kind === "text") {
            send("response.output_text.delta", { type: "response.output_text.delta", sequence_number: next(), output_index: 0, delta: event.delta.text });
          }
          if (event.kind === "partDelta" && event.delta.kind === "thinking") {
            send("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", sequence_number: next(), output_index: 0, delta: event.delta.text });
          }
        });

        if (state.failure !== null) {
          const disclosed = disclose(state.failure);
          // Responses 的失败必须走 response.failed；只发 [DONE] 会被调用方当成空成功。
          send("response.failed", {
            type: "response.failed", sequence_number: next(),
            response: { ...responsesEnvelope(state, request, options, "failed"), error: { code: disclosed.code, message: disclosed.message } },
          });
          finished = true;
        } else if (state.stopReason !== null) {
          send("response.completed", { type: "response.completed", sequence_number: next(), response: responsesEnvelope(state, request, options, "completed") });
          finished = true;
        }
      } catch (error) {
        options.onUnhandled?.("encode_exception", error);
      } finally {
        if (!finished) {
          send("response.failed", {
            type: "response.failed", sequence_number: next(),
            response: { id: options.messageId, object: "response", status: "failed", model: request.model, output: [], error: { code: "upstream_disconnected", message: "The upstream connection failed before completion." } },
          });
        }
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function encodeResponsesAggregate(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Promise<Response> {
  const state = await consume(events, options);
  if (state.failure !== null) {
    const disclosed = disclose(state.failure);
    return Response.json({ error: { type: disclosed.type, code: disclosed.code, message: disclosed.message } }, { status: disclosed.status });
  }
  if (state.stopReason === null) {
    return Response.json({
      error: { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion." },
    }, { status: 502 });
  }
  return Response.json(responsesEnvelope(state, request, options, "completed"));
}
