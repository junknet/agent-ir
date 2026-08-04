/**
 * IREvent 流 → OpenAI Chat Completions / Responses 出站响应。
 *
 * 两个协议共用同一个事件流与同一套错误披露，只在 wire 形状上分叉。
 * 关键不变量：**任何路径都不得产出「200 但空」的假成功** —— 上游中途失败必须以
 * 该协议自己的错误形态收尾（Chat 用 finish_reason + error chunk，Responses 用
 * response.failed），否则调用方无法区分「模型没话说」与「上游拒绝了」，只能盲重试。
 */
import { formatSse } from "../ir/sse.ts";
import { inputTokensIncludingCache } from "../ir/types.ts";
import type {
  IREvent, IRPart, IRRequest, IRResponsePart, IRStopReason, IRToolInput, IRUsage,
} from "../ir/types.ts";
import { assembleResponse, type IRResponse } from "../ir/response.ts";
import type { EncodeOptions } from "./shared.ts";

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
  // Chat 的 prompt_tokens **含**缓存命中，IRUsage 取 Anthropic 语义（不含），出站必须加回来。
  // 少加这一步，chat→IR→chat 往返会把缓存部分整个少报（实测缓存占比可达九成）。
  const promptTokens = inputTokensIncludingCache(usage);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
}

/** 累积器：两个协议的流式与非流式都从它取状态，避免四条路径长出四种行为。 */
class ResponseAccumulator {
  text = "";
  reasoning = "";
  readonly toolCalls: Array<{ id: string; group: string | null; name: string; arguments: string }> = [];
  readonly #toolIndexByPart = new Map<number, number>();
  usage: IRUsage | null = null;
  stopReason: IRStopReason | null = null;
  failure: Extract<IREvent, { kind: "error" }> | null = null;

  applyPartStart(index: number, part: IRPart): void {
    if (part.kind !== "toolCall") return;
    this.#toolIndexByPart.set(index, this.toolCalls.length);
    this.toolCalls.push({
      id: part.call.id,
      group: part.call.toolRef.group,
      name: part.call.toolRef.name,
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

  toolCall(index: number): Readonly<{ id: string; group: string | null; name: string; arguments: string }> | undefined {
    const position = this.#toolIndexByPart.get(index);
    return position === undefined ? undefined : this.toolCalls[position];
  }

  /**
   * 收尾时的 IR 形态。流式路径必须边收边发，用不了 assembleResponse 的整段折叠，
   * 但**收尾产物仍然是 IRResponse** —— 于是 envelope 构造只有一份，不因流式/非流式分叉。
   */
  toIRResponse(fallbackModel: string): IRResponse {
    const parts: IRResponsePart[] = [];
    if (this.reasoning.length > 0) parts.push({ kind: "thinking", text: this.reasoning });
    if (this.text.length > 0) parts.push({ kind: "text", text: this.text });
    for (const call of this.toolCalls) {
      let input: IRToolInput = { kind: "text", text: call.arguments };
      try {
        const parsed: unknown = JSON.parse(call.arguments.length === 0 ? "{}" : call.arguments);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = { kind: "json", value: parsed as Record<string, unknown> };
        }
      } catch { /* 保留 freeform 原文 */ }
      parts.push({ kind: "toolCall", call: { id: call.id, toolRef: { group: call.group, name: call.name }, input } });
    }
    return {
      model: fallbackModel,
      turn: { role: "assistant", parts },
      stopReason: this.stopReason,
      usage: this.usage,
      error: this.failure?.error ?? null,
      losses: [],
      unhandled: [],
    };
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
      case "messageStart": case "partEnd": case "loss": case "committed": case "heartbeat": break;
    }
    onEvent?.(event, accumulator);
  }
  return accumulator;
}

/**
 * IRResponse → OpenAI 的扁平视图。两个 OpenAI 协议都要「文本一坨、推理一坨、工具一列」，
 * 这个压平只此一处；`ResponseAccumulator` 只服务**流式**路径（它必须边收边发，折叠不了）。
 */
function flattenForOpenAI(assembled: IRResponse): {
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: ReadonlyArray<{ id: string; group: string | null; name: string; arguments: string }>;
} {
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; group: string | null; name: string; arguments: string }> = [];
  for (const part of assembled.turn.parts) {
    if (part.kind === "text") { text += part.text; continue; }
    if (part.kind === "thinking") { reasoning += part.text; continue; }
    if (part.kind === "toolCall") {
      toolCalls.push({
        id: part.call.id,
        group: part.call.toolRef.group,
        name: part.call.toolRef.name,
        arguments: part.call.input.kind === "json" ? JSON.stringify(part.call.input.value) : part.call.input.text,
      });
    }
    // redactedThinking 没有 OpenAI 对应形态，且内容本就不可读，静默略过不记 loss。
  }
  return { text, reasoning, toolCalls };
}

function chatToolName(call: { readonly group: string | null; readonly name: string }): string {
  return call.group === null ? call.name : `${call.group}__${call.name}`;
}

// ── Chat Completions ───────────────────────────────────────────────────────

export function writeChatCompletionsResponse(
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
            case "heartbeat":
              // SSE 注释行：规范内的合法字节，客户端解析器一律忽略，但足以让
              // 中间的 CDN/代理看到「数据还在流动」。生产实证静默 125.8s 即被掐。
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              break;
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
  // 折叠只有一个实现（ir/response.ts）；这里只做 IRResponse → Chat wire 的映射。
  const assembled = await assembleResponse(events, request.model);
  for (const event of assembled.unhandled) options.onUnhandled?.(event.rawType, event.raw);

  if (assembled.error !== null) {
    const disclosed = disclose({ kind: "error", error: assembled.error });
    return Response.json({ error: { type: disclosed.type, code: disclosed.code, message: disclosed.message } }, { status: disclosed.status });
  }
  if (assembled.stopReason === null) {
    return Response.json({
      error: { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion." },
    }, { status: 502 });
  }

  const view = flattenForOpenAI(assembled);
  return Response.json({
    id: options.messageId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: assembled.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: view.text.length === 0 ? null : view.text,
        ...(view.reasoning.length === 0 ? {} : { reasoning_content: view.reasoning }),
        ...(view.toolCalls.length === 0 ? {} : {
          tool_calls: view.toolCalls.map((call) => ({
            id: call.id, type: "function", function: { name: chatToolName(call), arguments: call.arguments },
          })),
        }),
      },
      finish_reason: CHAT_FINISH[assembled.stopReason],
    }],
    usage: usageWire(assembled.usage),
  });
}

// ── Responses ──────────────────────────────────────────────────────────────

export function writeResponsesResponse(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Response | Promise<Response> {
  return request.intent.stream.value
    ? writeClientResponsesStream(events, request, options)
    : writeClientResponsesAggregate(events, request, options);
}

function responsesOutput(assembled: IRResponse): Array<Record<string, unknown>> {
  const view = flattenForOpenAI(assembled);
  const output: Array<Record<string, unknown>> = [];
  if (view.reasoning.length > 0) {
    output.push({ type: "reasoning", id: `rs_${output.length}`, summary: [{ type: "summary_text", text: view.reasoning }] });
  }
  if (view.text.length > 0) {
    output.push({ type: "message", id: `msg_${output.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: view.text, annotations: [] }] });
  }
  for (const call of view.toolCalls) {
    output.push({ type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed", ...(call.group === null ? {} : { namespace: call.group }) });
  }
  return output;
}

function responsesEnvelope(
  assembled: IRResponse, request: IRRequest, options: EncodeOptions, status: string,
): Record<string, unknown> {
  return {
    id: options.messageId, object: "response", created_at: Math.floor(Date.now() / 1000),
    status, model: assembled.model.length > 0 ? assembled.model : request.model, output: responsesOutput(assembled),
    // 同上：Responses 的 input_tokens 也含缓存命中。
    usage: assembled.usage === null ? null : {
      input_tokens: inputTokensIncludingCache(assembled.usage),
      output_tokens: assembled.usage.outputTokens,
      total_tokens: inputTokensIncludingCache(assembled.usage) + assembled.usage.outputTokens,
    },
  };
}

function writeClientResponsesStream(events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => { controller.enqueue(encoder.encode(formatSse(event, data))); };
      let sequence = 0;
      const next = (): number => sequence++;
      let finished = false;
      const toolStreamItems = new Map<number, { readonly outputIndex: number; readonly itemId: string; readonly freeform: boolean }>();
      let nextOutputIndex = 0;
      try {
        send("response.created", { type: "response.created", sequence_number: next(), response: { id: options.messageId, object: "response", status: "in_progress", model: request.model, output: [] } });
        const state = await consume(events, options, (event, accumulator) => {
          if (event.kind === "heartbeat") { send("response.in_progress", { type: "response.in_progress", sequence_number: next() }); return; }
          if (event.kind === "partDelta" && event.delta.kind === "text") {
            send("response.output_text.delta", { type: "response.output_text.delta", sequence_number: next(), output_index: 0, delta: event.delta.text });
          }
          if (event.kind === "partDelta" && event.delta.kind === "thinking") {
            send("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", sequence_number: next(), output_index: 0, delta: event.delta.text });
          }
          if (event.kind === "partStart" && event.part.kind === "toolCall") {
            const freeform = event.part.call.input.kind === "text";
            const outputIndex = nextOutputIndex++;
            const itemId = `fc_${event.part.call.id}`;
            toolStreamItems.set(event.index, { outputIndex, itemId, freeform });
            const item = freeform
              ? { id: itemId, type: "custom_tool_call", status: "in_progress", call_id: event.part.call.id, name: event.part.call.toolRef.name, input: "" }
              : { id: itemId, type: "function_call", status: "in_progress", call_id: event.part.call.id, name: event.part.call.toolRef.name, arguments: "", ...(event.part.call.toolRef.group === null ? {} : { namespace: event.part.call.toolRef.group }) };
            send("response.output_item.added", { type: "response.output_item.added", sequence_number: next(), output_index: outputIndex, item });
            const initial = freeform
              ? event.part.call.input.text
              : Object.keys(event.part.call.input.value).length === 0 ? "" : JSON.stringify(event.part.call.input.value);
            if (initial.length > 0) {
              send(freeform ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", {
                type: freeform ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
                sequence_number: next(), output_index: outputIndex, item_id: itemId, delta: initial,
              });
            }
          }
          if (event.kind === "partDelta" && (event.delta.kind === "toolInputJson" || event.delta.kind === "toolInputText")) {
            const item = toolStreamItems.get(event.index);
            if (item !== undefined) {
              const type = item.freeform ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta";
              send(type, { type, sequence_number: next(), output_index: item.outputIndex, item_id: item.itemId, delta: event.delta.kind === "toolInputJson" ? event.delta.json : event.delta.text });
            }
          }
          if (event.kind === "partEnd") {
            const item = toolStreamItems.get(event.index);
            const call = accumulator.toolCall(event.index);
            if (item !== undefined && call !== undefined) {
              const doneType = item.freeform ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done";
              const input = item.freeform ? { input: call.arguments } : { arguments: call.arguments };
              send(doneType, { type: doneType, sequence_number: next(), output_index: item.outputIndex, item_id: item.itemId, ...input });
              send("response.output_item.done", {
                type: "response.output_item.done", sequence_number: next(), output_index: item.outputIndex,
                item: item.freeform
                  ? { id: item.itemId, type: "custom_tool_call", status: "completed", call_id: call.id, name: call.name, input: call.arguments }
                  : { id: item.itemId, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: call.arguments, ...(call.group === null ? {} : { namespace: call.group }) },
              });
            }
          }
        });

        if (state.failure !== null) {
          const disclosed = disclose(state.failure);
          // Responses 的失败必须走 response.failed；只发 [DONE] 会被调用方当成空成功。
          send("response.failed", {
            type: "response.failed", sequence_number: next(),
            response: { ...responsesEnvelope(state.toIRResponse(request.model), request, options, "failed"), error: { code: disclosed.code, message: disclosed.message } },
          });
          finished = true;
        } else if (state.stopReason !== null) {
          send("response.completed", { type: "response.completed", sequence_number: next(), response: responsesEnvelope(state.toIRResponse(request.model), request, options, "completed") });
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

async function writeClientResponsesAggregate(
  events: AsyncIterable<IREvent>, request: IRRequest, options: EncodeOptions,
): Promise<Response> {
  const assembled = await assembleResponse(events, request.model);
  for (const event of assembled.unhandled) options.onUnhandled?.(event.rawType, event.raw);

  if (assembled.error !== null) {
    const disclosed = disclose({ kind: "error", error: assembled.error });
    return Response.json({ error: { type: disclosed.type, code: disclosed.code, message: disclosed.message } }, { status: disclosed.status });
  }
  if (assembled.stopReason === null) {
    return Response.json({
      error: { type: "server_error", code: "upstream_disconnected", message: "The upstream connection failed before completion." },
    }, { status: 502 });
  }
  return Response.json(responsesEnvelope(assembled, request, options, "completed"));
}
