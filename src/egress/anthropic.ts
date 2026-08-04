/**
 * Anthropic Messages 出口：IR → wire（lower）+ 上游 SSE → IREvent（lift）。
 *
 * lower 是**唯一**恢复 Anthropic 位置不变量的地方：
 *   每个 tool_use 恰好一个 tool_result，且位于紧随该 assistant 回合之后那条 user 回合的最前面。
 * IR 内部靠 id 关联、与位置无关，所以三个入口都不需要各自维护这套排列规则 ——
 * agent-all-sdk-ts 里那份 179 行的 anthropic_constraints.ts 在这个架构下只剩这一个函数。
 */
import { iterateSse, tryParseJson } from "../ir/sse.ts";
import type {
  IREgress, IREgressProfile, IREvent, IRLoss, IRLowerResult, IRPart, IRRequest,
  IRStopReason, IRTurn, IRUpstreamError, IRUsage,
} from "../ir/types.ts";

const SUPPORTED = new Set([
  "stream", "nonStream", "systemPrompt", "multiTurn", "image", "document",
  "thinking", "thinkingSignature", "reasoningEffort", "reasoningBudget",
  "toolFunction", "toolBuiltin", "toolParallel", "toolChoiceSpecific",
  "toolResultImage", "toolResultError", "structuredOutput", "cacheBreakpoint",
  "contextEdit", "maxOutputTokens", "stopSequences", "temperature", "topP", "topK", "serviceTier",
] as const);

// toolFreeform：Anthropic 没有自由文本入参工具，只能包成单字段 JSON schema。
// toolGroup：没有 namespace 概念，只能把分组拍进名字。
// 两者都能承载，但都有损 —— 归 lossy，放行且强制留痕。
const LOSSY = new Set(["toolFreeform", "toolGroup"] as const);

export interface AnthropicEgressOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly anthropicVersion?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
}

class LowerLosses {
  readonly #losses: IRLoss[] = [];
  record(loss: Omit<IRLoss, "stage" | "provider">): void {
    this.#losses.push({ stage: "egress", provider: "anthropic", ...loss });
  }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
}

/** 分组名拍进工具名。这是有损的（分组结构没了），调用方靠 loss 知道。 */
function flatToolName(group: string | null, name: string): string {
  return group === null ? name : `${group}__${name}`;
}

function lowerPart(part: IRPart, path: string, losses: LowerLosses): Record<string, unknown> | null {
  const cache = part.cacheBreakpoint === undefined ? {} : { cache_control: { type: "ephemeral" } };
  switch (part.kind) {
    case "text":
      return part.text.length === 0 ? null : { type: "text", text: part.text, ...cache };
    case "image":
      return {
        type: "image",
        source: part.media.source.kind === "base64"
          ? { type: "base64", media_type: part.media.mediaType, data: part.media.source.data }
          : { type: "url", url: part.media.source.url },
        ...cache,
      };
    case "document":
      return {
        type: "document",
        source: part.media.source.kind === "base64"
          ? { type: "base64", media_type: part.media.mediaType, data: part.media.source.data }
          : { type: "url", url: part.media.source.url },
        ...(part.title === undefined ? {} : { title: part.title }),
        ...cache,
      };
    case "thinking":
      // 没有 signature 的 thinking 块会被上游拒；宁可丢块也不能让整条请求 400。
      if (part.signature === undefined) {
        losses.record({ path, kind: "dropped", detail: "thinking block without signature is rejected upstream" });
        return null;
      }
      return { type: "thinking", thinking: part.text, signature: part.signature, ...cache };
    case "redactedThinking":
      return { type: "redacted_thinking", data: part.data, ...cache };
    case "toolCall":
      return {
        type: "tool_use",
        id: part.call.id,
        name: flatToolName(part.call.toolRef.group, part.call.toolRef.name),
        input: part.call.input.kind === "json" ? part.call.input.value : { input: part.call.input.text },
        ...(part.call.caller === undefined ? {} : { caller: part.call.caller.raw }),
        ...cache,
      };
    case "toolResult": {
      const inner = part.result.parts
        .map((child, index) => lowerPart(child, `${path}.result.parts[${index}]`, losses))
        .filter((block): block is Record<string, unknown> => block !== null);
      return {
        type: "tool_result",
        tool_use_id: part.result.callId,
        // 空结果必须给一个占位：空数组与空串在部分端点上都会 400。
        content: inner.length === 0 ? "" : inner,
        ...(part.result.status === "error" ? { is_error: true } : {}),
        ...cache,
      };
    }
    case "opaque":
      // 同源的 opaque 原样放回（无损往返）；异源的没法翻译，丢弃并留痕。
      if (part.origin === "anthropic_messages") return part.raw as Record<string, unknown>;
      losses.record({
        path, kind: "dropped",
        detail: `opaque part from ${part.origin} (${part.tag}) has no Anthropic representation`,
      });
      return null;
  }
}

/**
 * 恢复 Anthropic 的工具回合位置不变量。
 *
 * 「先全摘下来再重排」而不是「就地打补丁」：就地修补要按每种破坏方式各堵一次，且步骤间
 * 有顺序陷阱（实测踩过：占位块 push 到 user 回合末尾会变成 [tool_result, text, tool_result]，
 * 上游 400；[text, tool_result] 顺序必死，[tool_result, text] 才过）。
 */
function arrangeToolTurns(turns: readonly IRTurn[], losses: LowerLosses): IRTurn[] {
  // 1. 摘出全部工具结果，按 callId 索引
  const resultsByCallId = new Map<string, IRPart>();
  const stripped: IRTurn[] = turns.map((turn) => ({
    role: turn.role,
    parts: turn.parts.filter((part) => {
      if (part.kind !== "toolResult") return true;
      resultsByCallId.set(part.result.callId, part);
      return false;
    }),
  }));

  // 2. 每个 assistant 回合之后，按该回合声明的调用顺序重铺结果
  const arranged: IRTurn[] = [];
  const consumed = new Set<string>();
  for (const turn of stripped) {
    arranged.push(turn);
    if (turn.role !== "assistant") continue;
    const callIds = turn.parts.flatMap((part) => (part.kind === "toolCall" ? [part.call.id] : []));
    if (callIds.length === 0) continue;
    const resultParts: IRPart[] = [];
    for (const callId of callIds) {
      const result = resultsByCallId.get(callId);
      if (result !== undefined) { resultParts.push(result); consumed.add(callId); continue; }
      // 悬空调用：客户端历史缺了结果。补占位而不是留空 —— 措辞要让模型知道结果不可信，
      // 假装工具返回空会让 agent 以为命令执行成功且无输出。
      resultParts.push({
        kind: "toolResult",
        result: {
          callId,
          parts: [{ kind: "text", text: "[gateway: tool result missing from client history; treat as unknown]" }],
          status: "missing",
        },
      });
      losses.record({
        path: `$.conversation.turns`, kind: "substituted",
        detail: `dangling tool call ${callId} filled with an explicit placeholder result`,
      });
    }
    // tool_result 必须排在紧随其后那条 user 回合的**最前面**
    arranged.push({ role: "user", parts: resultParts });
  }

  // 3. 孤儿结果（前面根本没有对应调用）只能丢：留着上游必 400
  for (const [callId] of resultsByCallId) {
    if (consumed.has(callId)) continue;
    losses.record({
      path: "$.conversation.turns", kind: "dropped",
      detail: `orphan tool result ${callId} has no matching call and is rejected upstream`,
    });
  }

  // 4. 重铺后可能出现相邻同角色（assistant 无调用 + 原有 user），合并
  const merged: IRTurn[] = [];
  for (const turn of arranged) {
    if (turn.parts.length === 0) continue;
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === turn.role) {
      merged[merged.length - 1] = { role: previous.role, parts: [...previous.parts, ...turn.parts] };
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

export function createAnthropicEgress(options: AnthropicEgressOptions): IREgress {
  const profile: IREgressProfile = {
    provider: "anthropic",
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
  };

  return {
    profile,

    async lower(request: IRRequest): Promise<IRLowerResult> {
      const losses = new LowerLosses();
      const { conversation, intent } = request;

      const system = conversation.system
        .map((part, index) => lowerPart(part, `$.conversation.system[${index}]`, losses))
        .filter((block): block is Record<string, unknown> => block !== null);

      const messages = arrangeToolTurns(conversation.turns, losses).map((turn, turnIndex) => ({
        role: turn.role,
        content: turn.parts
          .map((part, partIndex) => lowerPart(part, `$.conversation.turns[${turnIndex}].parts[${partIndex}]`, losses))
          .filter((block): block is Record<string, unknown> => block !== null),
      })).filter((message) => message.content.length > 0);

      const tools = conversation.toolset.tools.map((tool) => {
        if (tool.ref.group !== null) {
          losses.record({
            path: `$.conversation.toolset.tools`, kind: "degraded",
            detail: `tool group '${tool.ref.group}' flattened into the tool name; Anthropic has no namespace concept`,
          });
        }
        const name = flatToolName(tool.ref.group, tool.ref.name);
        if (tool.kind === "function") {
          return { name, description: tool.description, input_schema: tool.schema };
        }
        if (tool.kind === "freeform") {
          losses.record({
            path: `$.conversation.toolset.tools`, kind: "degraded",
            detail: `freeform tool '${name}' wrapped into a single-field JSON schema`,
          });
          return {
            name, description: tool.description,
            input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          };
        }
        return { type: tool.builtin, name, ...(tool.config ?? {}) };
      });

      const choice = conversation.toolset.choice.value;
      const toolChoice =
        choice.kind === "auto" ? { type: "auto" }
        : choice.kind === "none" ? { type: "none" }
        : choice.kind === "required" ? { type: "any" }
        : { type: "tool", name: flatToolName(choice.ref.group, choice.ref.name) };

      const reasoning = intent.reasoning.value;
      const thinking =
        reasoning.mode === "disabled" ? { type: "disabled" }
        : reasoning.mode === "adaptive" ? { type: "adaptive", display: reasoning.display }
        : reasoning.budgetTokens !== undefined ? { type: "enabled", budget_tokens: reasoning.budgetTokens }
        : undefined;

      const outputFormat = intent.outputFormat.value;
      const outputConfig = {
        ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
        ...(outputFormat.kind === "jsonSchema"
          ? { format: { type: "json_schema", schema: outputFormat.schema, ...(outputFormat.name === undefined ? {} : { name: outputFormat.name }) } }
          : {}),
      };

      // Anthropic 强制要求 max_tokens。客户端没给就必须补一个，并留痕说明这是网关决定的。
      let maxTokens = intent.stopping.maxOutputTokens?.value;
      if (maxTokens === undefined) {
        maxTokens = 4096;
        losses.record({
          path: "$.intent.stopping.maxOutputTokens", kind: "substituted",
          detail: "Anthropic requires max_tokens; gateway supplied a default of 4096",
        });
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        max_tokens: maxTokens,
        stream: intent.stream.value,
        ...(system.length === 0 ? {} : { system }),
        ...(tools.length === 0 ? {} : { tools }),
        ...(tools.length === 0 || conversation.toolset.choice.source !== "client" ? {} : { tool_choice: toolChoice }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
        ...(intent.sampling.temperature === undefined ? {} : { temperature: intent.sampling.temperature.value }),
        ...(intent.sampling.topP === undefined ? {} : { top_p: intent.sampling.topP.value }),
        ...(intent.sampling.topK === undefined ? {} : { top_k: intent.sampling.topK.value }),
        ...(intent.stopping.stopSequences === undefined ? {} : { stop_sequences: [...intent.stopping.stopSequences.value] }),
        ...(intent.contextEdits.length === 0 ? {} : { context_management: { edits: intent.contextEdits.map((edit) => edit.raw) } }),
      };

      return {
        wire: {
          url: `${options.baseUrl.replace(/\/$/u, "")}/v1/messages`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": options.anthropicVersion ?? "2023-06-01",
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        },
        losses: losses.drain(),
      };
    },

    lift(response: Response): AsyncIterable<IREvent> {
      return liftAnthropicStream(response);
    },
  };
}

// ── lift ───────────────────────────────────────────────────────────────────

function mapStopReason(raw: unknown): IRStopReason {
  switch (raw) {
    case "end_turn": return "endTurn";
    case "max_tokens": return "maxTokens";
    case "stop_sequence": return "stopSequence";
    case "tool_use": return "toolUse";
    case "refusal": return "refusal";
    default: return "endTurn";
  }
}

function mapUpstreamError(payload: unknown, httpStatus: number | null): IRUpstreamError {
  const holder = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const inner = typeof holder.error === "object" && holder.error !== null
    ? holder.error as Record<string, unknown> : holder;
  const type = typeof inner.type === "string" ? inner.type : "";
  const message = typeof inner.message === "string" ? inner.message : "upstream error";
  const kind: IRUpstreamError["kind"] =
    type === "invalid_request_error" ? "invalidRequest"
    : type === "authentication_error" || type === "permission_error" || type === "permission_denied" ? "permissionDenied"
    : type === "rate_limit_error" ? "rateLimited"
    : type === "overloaded_error" || type === "api_error" ? "upstreamUnavailable"
    : /context.{0,12}length|too long|exceeds? the (maximum|context)/iu.test(message) ? "contextLengthExceeded"
    : "unknown";
  return {
    kind,
    httpStatus,
    message,
    retryable: kind === "rateLimited" || kind === "upstreamUnavailable",
    raw: payload,
  };
}

function usageFrom(raw: unknown): IRUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

async function* liftAnthropicStream(response: Response): AsyncGenerator<IREvent> {
  // 非 2xx：整体读出来当一次性错误，不进 SSE 解析。
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapUpstreamError(tryParseJson(text) ?? text, response.status) };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // 非流式：一次性 Message JSON 转成等价事件序列，下游 encode 不需要区分两条路径。
    const text = await response.text();
    const payload = tryParseJson<Record<string, unknown>>(text);
    if (payload === null) {
      yield { kind: "error", error: mapUpstreamError(text, response.status) };
      return;
    }
    if (payload.type === "error") {
      yield { kind: "error", error: mapUpstreamError(payload, response.status) };
      return;
    }
    yield { kind: "messageStart", model: typeof payload.model === "string" ? payload.model : "" };
    const content = Array.isArray(payload.content) ? payload.content : [];
    let index = 0;
    for (const block of content) {
      const part = blockToPart(block);
      if (part === null) { yield { kind: "unhandled", rawType: "content_block", raw: block }; continue; }
      yield { kind: "partStart", index, part };
      yield { kind: "partEnd", index };
      index += 1;
    }
    const usage = usageFrom(payload.usage);
    if (usage !== null) yield { kind: "usage", usage };
    yield { kind: "messageStop", reason: mapStopReason(payload.stop_reason) };
    return;
  }

  const toolInputBuffers = new Map<number, string>();
  let sawTerminal = false;

  for await (const frame of iterateSse(response)) {
    const payload = tryParseJson<Record<string, unknown>>(frame.data);
    if (payload === null) {
      yield { kind: "unhandled", rawType: frame.event ?? "<no-event>", raw: frame.data };
      continue;
    }
    const type = typeof payload.type === "string" ? payload.type : (frame.event ?? "");

    switch (type) {
      case "message_start": {
        const message = typeof payload.message === "object" && payload.message !== null
          ? payload.message as Record<string, unknown> : {};
        yield { kind: "messageStart", model: typeof message.model === "string" ? message.model : "" };
        const usage = usageFrom(message.usage);
        if (usage !== null) yield { kind: "usage", usage };
        break;
      }

      case "content_block_start": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const part = blockToPart(payload.content_block);
        if (part === null) { yield { kind: "unhandled", rawType: "content_block_start", raw: payload }; break; }
        if (part.kind === "toolCall") toolInputBuffers.set(index, "");
        yield { kind: "partStart", index, part };
        break;
      }

      case "content_block_delta": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const delta = typeof payload.delta === "object" && payload.delta !== null
          ? payload.delta as Record<string, unknown> : {};
        switch (delta.type) {
          case "text_delta":
            yield { kind: "partDelta", index, delta: { kind: "text", text: String(delta.text ?? "") } };
            break;
          case "thinking_delta":
            yield { kind: "partDelta", index, delta: { kind: "thinking", text: String(delta.thinking ?? "") } };
            break;
          case "signature_delta":
            yield { kind: "partDelta", index, delta: { kind: "thinkingSignature", signature: String(delta.signature ?? "") } };
            break;
          case "input_json_delta": {
            const json = String(delta.partial_json ?? "");
            toolInputBuffers.set(index, (toolInputBuffers.get(index) ?? "") + json);
            yield { kind: "partDelta", index, delta: { kind: "toolInputJson", json } };
            break;
          }
          default:
            yield { kind: "unhandled", rawType: `content_block_delta:${String(delta.type)}`, raw: payload };
        }
        break;
      }

      case "content_block_stop":
        yield { kind: "partEnd", index: typeof payload.index === "number" ? payload.index : 0 };
        break;

      case "message_delta": {
        const usage = usageFrom(payload.usage);
        if (usage !== null) yield { kind: "usage", usage };
        const delta = typeof payload.delta === "object" && payload.delta !== null
          ? payload.delta as Record<string, unknown> : {};
        if (delta.stop_reason !== undefined) {
          sawTerminal = true;
          yield { kind: "messageStop", reason: mapStopReason(delta.stop_reason) };
        }
        break;
      }

      case "message_stop":
        if (!sawTerminal) { sawTerminal = true; yield { kind: "messageStop", reason: "endTurn" }; }
        break;

      case "error":
        sawTerminal = true;
        yield { kind: "error", error: mapUpstreamError(payload, null) };
        break;

      case "ping":
        break;

      default:
        // 不变量 4：没匹配上的事件是流里的元素，不是 switch 的黑洞。
        yield { kind: "unhandled", rawType: type.length === 0 ? "<empty>" : type, raw: payload };
    }
  }

  // 上游把流掐断却没发终止帧：必须显式终止，否则调用方看到的是「200 但空」。
  if (!sawTerminal) {
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a terminal event",
        raw: null,
      },
    };
  }
}

function blockToPart(raw: unknown): IRPart | null {
  if (typeof raw !== "object" || raw === null) return null;
  const block = raw as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return { kind: "text", text: typeof block.text === "string" ? block.text : "" };
    case "thinking": {
      const signature = typeof block.signature === "string" ? block.signature : undefined;
      return {
        kind: "thinking",
        text: typeof block.thinking === "string" ? block.thinking : "",
        ...(signature === undefined ? {} : { signature }),
      };
    }
    case "redacted_thinking":
      return { kind: "redactedThinking", data: typeof block.data === "string" ? block.data : "" };
    case "tool_use": {
      const id = typeof block.id === "string" ? block.id : null;
      const name = typeof block.name === "string" ? block.name : null;
      if (id === null || name === null) return null;
      return {
        kind: "toolCall",
        call: {
          id, toolRef: { group: null, name },
          input: { kind: "json", value: typeof block.input === "object" && block.input !== null ? block.input as Record<string, unknown> : {} },
        },
      };
    }
    default:
      return null;
  }
}
