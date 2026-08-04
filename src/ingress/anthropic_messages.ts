/**
 * Anthropic Messages（POST /v1/messages）→ IR。
 *
 * 语料覆盖：611 条全量归档请求，28008 条消息，14155 组 tool_use/tool_result，
 * assistant 回合 27 种形态，最深 turn_index 1689。
 */
import { deriveCapabilityNeeds } from "../ir/capabilities.ts";
import {
  clientValue, defaultValue,
  type IRContextEdit, type IRIntent, type IROutputFormat, type IRPart,
  type ClientRequestReadResult, type IRReasoning, type IRReasoningDisplay, type IRReasoningMode,
  type IRTool, type IRToolChoice, type IRToolGroup, type IRToolRef, type IRToolset, type IRTurn,
} from "../ir/types.ts";
import {
  asFiniteNumber, asString, isRecord, LossRecorder, normalizeTurns, parseEffort,
  opaquePart, parseCacheBreakpoint, parseImageBlob, parseSessionIdentity, textPart,
} from "./shared.ts";

const PROTOCOL = "anthropic_messages" as const;
// ── content ────────────────────────────────────────────────────────────────

function decodeBlock(block: unknown, path: string, losses: LossRecorder): IRPart {
  if (typeof block === "string") return textPart(block);
  if (!isRecord(block)) {
    losses.record({ path, kind: "substituted", detail: `non-object content block of type ${typeof block}` });
    return opaquePart(PROTOCOL, "non-object", block);
  }
  const cacheBreakpoint = parseCacheBreakpoint(block.cache_control);
  const withCache = <T extends IRPart>(part: T): IRPart =>
    (cacheBreakpoint === undefined ? part : { ...part, cacheBreakpoint });

  switch (block.type) {
    case "text":
      if (asString(block.text) === null) {
        losses.record({ path: `${path}.text`, kind: "substituted", detail: "text block without a string text value" });
      }
      return withCache({ kind: "text", text: asString(block.text) ?? "" });

    case "thinking": {
      const signature = asString(block.signature);
      return withCache({
        kind: "thinking",
        text: asString(block.thinking) ?? "",
        ...(signature === null ? {} : { signature }),
      });
    }

    case "redacted_thinking":
      return withCache({ kind: "redactedThinking", data: asString(block.data) ?? "" });

    case "image":
    case "document": {
      const source = isRecord(block.source) ? block.source : null;
      const media = source === null ? null : parseImageBlob({
        url: source.url,
        base64: source.data,
        mediaType: source.media_type,
      });
      if (media === null) {
        losses.record({ path, kind: "substituted", detail: `${String(block.type)} block without a usable source` });
        return opaquePart(PROTOCOL, String(block.type), block);
      }
      if (block.type === "image") return withCache({ kind: "image", media });
      const title = asString(block.title);
      return withCache({ kind: "document", media, ...(title === null ? {} : { title }) });
    }

    case "tool_use": {
      const id = asString(block.id);
      const name = asString(block.name);
      if (id === null || name === null) {
        losses.record({ path, kind: "substituted", detail: "tool_use block missing id or name" });
        return opaquePart(PROTOCOL, "tool_use", block);
      }
      // caller 实测是对象 `{type:'direct'}`，不是字符串；按字符串读会静默丢掉整个字段。
      const caller = isRecord(block.caller)
        ? { kind: asString(block.caller.type) ?? "unknown", raw: block.caller }
        : null;
      // input 恒为对象；freeform 工具的调用在 wire 上仍走 input，由工具定义决定语义。
      if (!isRecord(block.input)) {
        losses.record({ path: `${path}.input`, kind: "substituted", detail: "tool_use input is not an object; substituted with an empty object" });
      }
      return withCache({
        kind: "toolCall",
        call: {
          id,
          toolRef: { group: null, name },
          input: { kind: "json", value: isRecord(block.input) ? block.input : {} },
          ...(caller === null ? {} : { caller }),
        },
      });
    }

    case "tool_result": {
      const callId = asString(block.tool_use_id);
      if (callId === null) {
        losses.record({ path, kind: "substituted", detail: "tool_result block without tool_use_id" });
        return opaquePart(PROTOCOL, "tool_result", block);
      }
      const raw = block.content;
      const parts: IRPart[] = typeof raw === "string"
        ? (raw.length === 0 ? [] : [textPart(raw)])
        : Array.isArray(raw)
          ? raw.map((inner, index) => decodeBlock(inner, `${path}.content[${index}]`, losses))
          : [];
      return withCache({
        kind: "toolResult",
        result: { callId, parts, status: block.is_error === true ? "error" : "ok" },
      });
    }

    default:
      // 不认识的块**不丢**：装箱后由 egress 显式处置。丢在这里等于让所有出口都失去选择权。
      losses.record({
        path, kind: "degraded",
        detail: `unmodelled Anthropic content block '${String(block.type)}' boxed as opaque`,
      });
      return withCache(opaquePart(PROTOCOL, String(block.type ?? "unknown"), block));
  }
}

function decodeContent(content: unknown, path: string, losses: LossRecorder): IRPart[] {
  if (typeof content === "string") return content.length === 0 ? [] : [textPart(content)];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    losses.record({ path, kind: "substituted", detail: `content is ${typeof content}, expected string or array` });
    return [opaquePart(PROTOCOL, "content", content)];
  }
  return content.map((block, index) => decodeBlock(block, `${path}[${index}]`, losses));
}

// ── tools ──────────────────────────────────────────────────────────────────

function decodeTool(tool: unknown, path: string, losses: LossRecorder): IRTool | null {
  if (!isRecord(tool)) {
    losses.record({ path, kind: "dropped", detail: "non-object tool definition" });
    return null;
  }
  const name = asString(tool.name);
  if (name === null) {
    losses.record({ path, kind: "dropped", detail: "tool definition without a name" });
    return null;
  }
  const ref: IRToolRef = { group: null, name };
  const description = asString(tool.description) ?? "";
  const type = asString(tool.type);

  const schema = isRecord(tool.input_schema) ? tool.input_schema : null;

  // `type:'custom'` **仍然带 input_schema**（实测三例全部带）。把它一律当 freeform 会丢掉
  // 整个参数契约，上游拿不到 schema 就只能瞎猜参数。只有真的没有 schema 才是 freeform。
  if (type === "custom") {
    return schema === null
      ? { kind: "freeform", ref, description }
      : { kind: "function", ref, description, schema };
  }
  if (type !== null && type !== "function") {
    // computer_20251124 / bash_* / text_editor_* / web_search 这类上游内建工具：
    // 只有身份与配置，执行在上游，没有本地 schema。
    const { name: _name, type: _type, description: _description, ...config } = tool;
    return { kind: "builtin", ref, builtin: type, ...(Object.keys(config).length === 0 ? {} : { config }) };
  }

  if (schema === null) {
    losses.record({
      path, kind: "degraded",
      detail: "function tool without input_schema treated as freeform",
    });
    return { kind: "freeform", ref, description };
  }
  return {
    kind: "function", ref, description, schema,
    ...(tool.defer_loading === true ? { deferLoading: true } : {}),
  };
}

function decodeToolChoice(value: unknown, losses: LossRecorder): IRToolChoice | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    losses.record({ path: "$.tool_choice", kind: "dropped", detail: `tool_choice is ${typeof value}` });
    return null;
  }
  switch (value.type) {
    case "auto": return { kind: "auto" };
    case "any": return { kind: "required" };
    case "none": return { kind: "none" };
    case "tool": {
      const name = asString(value.name);
      if (name === null) {
        losses.record({ path: "$.tool_choice", kind: "dropped", detail: "tool_choice type=tool without name" });
        return null;
      }
      return { kind: "specific", ref: { group: null, name } };
    }
    default:
      losses.record({ path: "$.tool_choice", kind: "dropped", detail: `unknown tool_choice type '${String(value.type)}'` });
      return null;
  }
}

// ── intent ─────────────────────────────────────────────────────────────────

function decodeReasoning(body: Record<string, unknown>): IRReasoning {
  const thinking = isRecord(body.thinking) ? body.thinking : null;
  const outputConfig = isRecord(body.output_config) ? body.output_config : null;

  let mode: IRReasoningMode = "auto";
  let budgetTokens: number | undefined;
  if (thinking !== null) {
    const type = asString(thinking.type);
    if (type === "disabled") mode = "disabled";
    else if (type === "adaptive") mode = "adaptive";
    else if (type === "enabled") mode = "enabled";
    const budget = asFiniteNumber(thinking.budget_tokens);
    if (budget !== null) budgetTokens = budget;
  }

  const displayRaw = thinking === null ? null : asString(thinking.display);
  const display: IRReasoningDisplay =
    displayRaw === "summarized" ? "summarized" : displayRaw === "full" ? "full"
    : mode === "disabled" ? "hidden" : "full";

  // effort 的权威来源是 output_config.effort（语料 355 次）；thinking 里没有 effort 字段。
  const effort = outputConfig === null ? undefined : parseEffort(outputConfig.effort);

  return {
    mode, display,
    ...(effort === undefined ? {} : { effort }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  };
}

function decodeOutputFormat(body: Record<string, unknown>, losses: LossRecorder): IROutputFormat {
  const outputConfig = isRecord(body.output_config) ? body.output_config : null;
  const format = outputConfig !== null && isRecord(outputConfig.format) ? outputConfig.format : null;
  if (format === null) return { kind: "text" };
  if (format.type !== "json_schema") {
    losses.record({
      path: "$.output_config.format", kind: "dropped",
      detail: `unknown output format '${String(format.type)}'`,
    });
    return { kind: "text" };
  }
  const schema = isRecord(format.schema) ? format.schema : null;
  if (schema === null) {
    losses.record({ path: "$.output_config.format.schema", kind: "dropped", detail: "json_schema format without schema" });
    return { kind: "text" };
  }
  const name = asString(format.name);
  return {
    kind: "jsonSchema", schema,
    ...(name === null ? {} : { name }),
    ...(format.strict === true ? { strict: true } : {}),
  };
}

function decodeContextEdits(body: Record<string, unknown>): IRContextEdit[] {
  const management = isRecord(body.context_management) ? body.context_management : null;
  if (management === null || !Array.isArray(management.edits)) return [];
  return management.edits.filter(isRecord).map((edit): IRContextEdit => {
    const type = asString(edit.type) ?? "";
    const kind = type.startsWith("clear_thinking") ? "clearThinking"
      : type.startsWith("clear_tool_uses") || type.startsWith("clear_tool_results") ? "clearToolResults"
      : "unknown";
    const keepRaw = edit.keep;
    const keep = keepRaw === "all" ? "all" as const
      : keepRaw === "none" ? "none" as const
      : isRecord(keepRaw) && asFiniteNumber(keepRaw.value) !== null
        ? { lastTurns: asFiniteNumber(keepRaw.value) as number }
        : "all" as const;
    return { kind, keep, raw: edit };
  });
}

// ── entry ──────────────────────────────────────────────────────────────────

export function readAnthropicMessagesRequest(raw: unknown, traceId: string): ClientRequestReadResult {
  const losses = new LossRecorder();
  if (!isRecord(raw)) throw new TypeError("anthropic messages body must be a JSON object");
  const body = raw;

  // system 有两个载体：顶层 system（string 148 / array 420）与 messages 里的 role:'system'（1537）。
  // 两者都归位到 conversation.system，IR 里不再有 system 角色的回合。
  const system: IRPart[] = decodeContent(body.system, "$.system", losses);

  const turns: IRTurn[] = [];
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    losses.record({ path: "$.messages", kind: "dropped", detail: "messages is not an array" });
  }
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  rawMessages.forEach((message, index) => {
    if (!isRecord(message)) {
      losses.record({ path: `$.messages[${index}]`, kind: "dropped", detail: "non-object message" });
      return;
    }
    const parts = decodeContent(message.content, `$.messages[${index}].content`, losses);
    if (message.role === "system") { system.push(...parts); return; }
    if (message.role === "user" || message.role === "assistant") {
      turns.push({ role: message.role, parts });
      return;
    }
    losses.record({
      path: `$.messages[${index}].role`, kind: "dropped",
      detail: `unknown message role '${String(message.role)}'`,
    });
  });

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    losses.record({ path: "$.tools", kind: "dropped", detail: "tools is not an array" });
  }
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = rawTools
    .map((tool, index) => decodeTool(tool, `$.tools[${index}]`, losses))
    .filter((tool): tool is IRTool => tool !== null);
  const groups: IRToolGroup[] = [];
  const choice = decodeToolChoice(body.tool_choice, losses);

  const toolset: IRToolset = {
    tools, groups,
    choice: choice === null ? defaultValue<IRToolChoice>({ kind: "auto" }) : clientValue(choice),
    // Anthropic 默认允许并行；disable_parallel_tool_use 是反向开关。
    parallel: isRecord(body.tool_choice) && body.tool_choice.disable_parallel_tool_use === true
      ? clientValue(false)
      : defaultValue(true),
  };

  const maxTokens = asFiniteNumber(body.max_tokens);
  const temperature = asFiniteNumber(body.temperature);
  const topP = asFiniteNumber(body.top_p);
  const topK = asFiniteNumber(body.top_k);
  const stopSequences = Array.isArray(body.stop_sequences)
    ? body.stop_sequences.filter((entry): entry is string => typeof entry === "string")
    : null;

  const intent: IRIntent = {
    reasoning: clientValue(decodeReasoning(body)),
    outputFormat: clientValue(decodeOutputFormat(body, losses)),
    serviceTier: body.speed === "fast" || body.service_tier === "priority"
      ? clientValue("priority" as const)
      : defaultValue("standard" as const),
    sampling: {
      ...(temperature === null ? {} : { temperature: clientValue(temperature) }),
      ...(topP === null ? {} : { topP: clientValue(topP) }),
      ...(topK === null ? {} : { topK: clientValue(topK) }),
    },
    stopping: {
      ...(maxTokens === null ? {} : { maxOutputTokens: clientValue(maxTokens) }),
      ...(stopSequences === null || stopSequences.length === 0 ? {} : { stopSequences: clientValue(stopSequences) }),
    },
    contextEdits: decodeContextEdits(body),
    stream: body.stream === true ? clientValue(true) : defaultValue(false),
    identity: parseSessionIdentity(body.metadata),
  };

  const conversation = {
    system,
    turns: normalizeTurns(turns),
    toolset,
  };
  const partial = {
    traceId,
    protocol: PROTOCOL,
    model: asString(body.model) ?? "",
    conversation,
    intent,
  };
  return { request: { ...partial, requires: deriveCapabilityNeeds(partial) }, losses: losses.drain() };
}
