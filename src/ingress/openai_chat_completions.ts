/**
 * OpenAI Chat Completions（POST /v1/chat/completions）→ IR。
 *
 * 语料覆盖：116 条全量归档请求，5159 条消息。角色分布 tool 2355 / assistant 2231 /
 * user 490 / system 83 —— **tool 是出现最多的角色**，这个协议把工具结果编码成独立消息，
 * 并行调用会产生连续多条 tool 消息（202 次），这正是转回 Anthropic 时最容易炸的地方。
 */
import { deriveCapabilityNeeds } from "../ir/capabilities.ts";
import {
  clientValue, defaultValue,
  type ClientRequestReadResult, type IRIntent, type IROutputFormat, type IRPart,
  type IRReasoning, type IRTool, type IRToolChoice, type IRToolRef, type IRToolset, type IRTurn,
} from "../ir/types.ts";
import {
  asFiniteNumber, asString, isRecord, LossRecorder, normalizeTurns, parseEffort, parseStringToolChoice,
  opaquePart, parseImageBlob, textPart,
} from "./shared.ts";

const PROTOCOL = "openai_chat_completions" as const;
function decodeContentPart(part: unknown, path: string, losses: LossRecorder): IRPart {
  if (typeof part === "string") return textPart(part);
  if (!isRecord(part)) {
    losses.record({ path, kind: "substituted", detail: `non-object content part of type ${typeof part}` });
    return opaquePart(PROTOCOL, "non-object", part);
  }
  switch (part.type) {
    case "text":
      return { kind: "text", text: asString(part.text) ?? "" };
    case "image_url": {
      const holder = isRecord(part.image_url) ? part.image_url : null;
      const media = parseImageBlob({ url: holder === null ? part.image_url : holder.url });
      if (media === null) {
        losses.record({ path, kind: "substituted", detail: "image_url part without a usable url" });
        return opaquePart(PROTOCOL, "image_url", part);
      }
      return { kind: "image", media };
    }
    case "input_audio":
    case "file":
    default:
      losses.record({
        path, kind: "degraded",
        detail: `unmodelled chat content part '${String(part.type)}' boxed as opaque`,
      });
      return opaquePart(PROTOCOL, String(part.type ?? "unknown"), part);
  }
}

function decodeContent(content: unknown, path: string, losses: LossRecorder): IRPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content.length === 0 ? [] : [textPart(content)];
  if (Array.isArray(content)) {
    return content.map((part, index) => decodeContentPart(part, `${path}[${index}]`, losses));
  }
  losses.record({ path, kind: "substituted", detail: `content is ${typeof content}` });
  return [opaquePart(PROTOCOL, "content", content)];
}

/** `tool_calls[].function.arguments` 是 JSON **字符串**；解析失败保留原文当 freeform 入参。 */
function decodeToolCallParts(message: Record<string, unknown>, path: string, losses: LossRecorder): IRPart[] {
  if (!Array.isArray(message.tool_calls)) return [];
  const parts: IRPart[] = [];
  message.tool_calls.forEach((call, index) => {
    if (!isRecord(call)) return;
    const id = asString(call.id);
    const fn = isRecord(call.function) ? call.function : null;
    const name = fn === null ? null : asString(fn.name);
    if (id === null || name === null) {
      losses.record({ path: `${path}.tool_calls[${index}]`, kind: "substituted", detail: "tool_call without id or function.name" });
      parts.push(opaquePart(PROTOCOL, "tool_call", call));
      return;
    }
    const argumentsText = asString(fn?.arguments) ?? "";
    let parsed: unknown;
    try { parsed = argumentsText.length === 0 ? {} : JSON.parse(argumentsText); } catch { parsed = undefined; }
    const ref: IRToolRef = { group: null, name };
    parts.push({
      kind: "toolCall",
      call: isRecord(parsed)
        ? { id, toolRef: ref, input: { kind: "json", value: parsed } }
        : { id, toolRef: ref, input: { kind: "text", text: argumentsText } },
    });
    if (!isRecord(parsed)) {
      losses.record({
        path: `${path}.tool_calls[${index}].function.arguments`, kind: "degraded",
        detail: "tool call arguments are not a JSON object; preserved as freeform text input",
      });
    }
  });
  return parts;
}

function decodeTool(tool: unknown, path: string, losses: LossRecorder): IRTool | null {
  if (!isRecord(tool)) {
    losses.record({ path, kind: "dropped", detail: "non-object tool definition" });
    return null;
  }
  // Chat 的工具恒是 {type:'function', function:{name, description, parameters}}（语料 16802 次）。
  const fn = isRecord(tool.function) ? tool.function : tool;
  const name = asString(fn.name);
  if (name === null) {
    losses.record({ path, kind: "dropped", detail: "tool definition without a name" });
    return null;
  }
  const ref: IRToolRef = { group: null, name };
  const description = asString(fn.description) ?? "";
  const schema = isRecord(fn.parameters) ? fn.parameters : null;
  if (schema === null) return { kind: "freeform", ref, description };
  return {
    kind: "function", ref, description, schema,
    ...(fn.strict === true ? { strict: true } : {}),
  };
}

function decodeToolChoice(value: unknown, losses: LossRecorder): IRToolChoice | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parsed = parseStringToolChoice(value);
    if (parsed !== null) return parsed;
    losses.record({ path: "$.tool_choice", kind: "dropped", detail: `unknown tool_choice '${value}'` });
    return null;
  }
  if (isRecord(value) && value.type === "function") {
    const fn = isRecord(value.function) ? value.function : null;
    const name = fn === null ? null : asString(fn.name);
    if (name !== null) return { kind: "specific", ref: { group: null, name } };
  }
  losses.record({ path: "$.tool_choice", kind: "dropped", detail: "unrecognized tool_choice shape" });
  return null;
}

function decodeOutputFormat(body: Record<string, unknown>, losses: LossRecorder): IROutputFormat {
  const format = isRecord(body.response_format) ? body.response_format : null;
  if (format === null) return { kind: "text" };
  if (format.type === "text") return { kind: "text" };
  if (format.type === "json_schema") {
    const holder = isRecord(format.json_schema) ? format.json_schema : null;
    const schema = holder !== null && isRecord(holder.schema) ? holder.schema : null;
    if (schema === null) {
      losses.record({ path: "$.response_format.json_schema", kind: "dropped", detail: "json_schema without schema" });
      return { kind: "text" };
    }
    const name = holder === null ? null : asString(holder.name);
    return {
      kind: "jsonSchema", schema,
      ...(name === null ? {} : { name }),
      ...(holder?.strict === true ? { strict: true } : {}),
    };
  }
  // json_object 只保证「是 JSON」，没有 schema。降级成 text 并留痕，不假装等价。
  losses.record({
    path: "$.response_format", kind: "degraded",
    detail: `response_format '${String(format.type)}' has no schema equivalent in IR`,
  });
  return { kind: "text" };
}

export function readChatCompletionsRequest(raw: unknown, traceId: string): ClientRequestReadResult {
  const losses = new LossRecorder();
  if (!isRecord(raw)) throw new TypeError("chat completions body must be a JSON object");
  const body = raw;

  const system: IRPart[] = [];
  const turns: IRTurn[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  rawMessages.forEach((message, index) => {
    const path = `$.messages[${index}]`;
    if (!isRecord(message)) {
      losses.record({ path, kind: "dropped", detail: "non-object message" });
      return;
    }
    const role = asString(message.role);

    if (role === "system" || role === "developer") {
      system.push(...decodeContent(message.content, `${path}.content`, losses));
      return;
    }

    // role:'tool' 是 wire 层的编码技巧，不是语义角色：它承载的是上一条 assistant
    // 工具调用的结果，归位成 user 回合里的 toolResult part。相邻的多条会在 merge 阶段合并，
    // 于是并行工具调用不会退化成多条 user 消息。
    if (role === "tool") {
      const callId = asString(message.tool_call_id);
      if (callId === null) {
        losses.record({ path, kind: "dropped", detail: "tool message without tool_call_id cannot be correlated" });
        return;
      }
      turns.push({
        role: "user",
        parts: [{
          kind: "toolResult",
          result: { callId, parts: decodeContent(message.content, `${path}.content`, losses), status: "ok" },
        }],
      });
      return;
    }

    if (role === "assistant") {
      turns.push({
        role: "assistant",
        parts: [
          ...decodeContent(message.content, `${path}.content`, losses),
          ...decodeToolCallParts(message, path, losses),
        ],
      });
      return;
    }

    if (role === "user") {
      turns.push({ role: "user", parts: decodeContent(message.content, `${path}.content`, losses) });
      return;
    }

    losses.record({ path: `${path}.role`, kind: "dropped", detail: `unknown message role '${String(role)}'` });
  });

  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = rawTools
    .map((tool, index) => decodeTool(tool, `$.tools[${index}]`, losses))
    .filter((tool): tool is IRTool => tool !== null);
  const choice = decodeToolChoice(body.tool_choice, losses);

  const toolset: IRToolset = {
    tools, groups: [],
    choice: choice === null ? defaultValue<IRToolChoice>({ kind: "auto" }) : clientValue(choice),
    parallel: typeof body.parallel_tool_calls === "boolean"
      ? clientValue(body.parallel_tool_calls)
      : defaultValue(true),
  };

  const effort = parseEffort(body.reasoning_effort);
  const reasoning: IRReasoning = {
    mode: effort === undefined ? "auto" : "enabled",
    display: "summarized",
    ...(effort === undefined ? {} : { effort }),
  };

  // Chat 的三个 token 上限键语义相同，取先出现的那个。
  const maxTokens = asFiniteNumber(body.max_completion_tokens)
    ?? asFiniteNumber(body.max_tokens)
    ?? asFiniteNumber(body.max_output_tokens);
  const temperature = asFiniteNumber(body.temperature);
  const topP = asFiniteNumber(body.top_p);
  const stop = typeof body.stop === "string" ? [body.stop]
    : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === "string")
    : null;

  const intent: IRIntent = {
    reasoning: effort === undefined ? defaultValue(reasoning) : clientValue(reasoning),
    outputFormat: clientValue(decodeOutputFormat(body, losses)),
    serviceTier: body.service_tier === "priority" ? clientValue("priority" as const) : defaultValue("standard" as const),
    sampling: {
      ...(temperature === null ? {} : { temperature: clientValue(temperature) }),
      ...(topP === null ? {} : { topP: clientValue(topP) }),
    },
    stopping: {
      ...(maxTokens === null ? {} : { maxOutputTokens: clientValue(maxTokens) }),
      ...(stop === null || stop.length === 0 ? {} : { stopSequences: clientValue(stop) }),
    },
    contextEdits: [],
    stream: body.stream === true ? clientValue(true) : defaultValue(false),
    identity: {},
  };

  const conversation = { system, turns: normalizeTurns(turns), toolset };
  const partial = { traceId, protocol: PROTOCOL, model: asString(body.model) ?? "", conversation, intent };
  return { request: { ...partial, requires: deriveCapabilityNeeds(partial) }, losses: losses.drain() };
}
