/**
 * OpenAI Responses（POST /v1/responses）→ IR。
 *
 * 语料来源有二：80 条全量归档请求（顶层字段与 message/input_image/namespace/web_search 形态），
 * 以及 6 份真实 codex rollout（input item 类型与键集，共 1003 message / 245 reasoning /
 * 226 custom_tool_call / 226 custom_tool_call_output / 12 function_call）。
 *
 * 与另外两个协议最大的不同：**input 是扁平 item 序列，不是 message 序列**。
 * 工具调用、工具结果、推理各自是独立 item，靠 call_id 关联 —— 这正好是 IR 的原生形态，
 * 所以这个 decoder 反而最简单：它不需要重建任何位置不变量。
 */
import { deriveCapabilityNeeds } from "../ir/capabilities.ts";
import {
  clientValue, defaultValue,
  type ClientRequestReadResult, type IRIntent, type IROutputFormat, type IRPart,
  type IRReasoning, type IRReasoningDisplay, type IRTool, type IRToolChoice, type IRToolGroup,
  type IRToolRef, type IRToolset, type IRTurn,
} from "../ir/types.ts";
import {
  asFiniteNumber, asString, isRecord, LossRecorder, normalizeTurns, parseEffort, parseStringToolChoice,
  opaquePart, parseImageBlob, textPart,
} from "./shared.ts";

const PROTOCOL = "openai_responses" as const;
function decodeContentPart(part: unknown, path: string, losses: LossRecorder): IRPart {
  if (typeof part === "string") return textPart(part);
  if (!isRecord(part)) {
    losses.record({ path, kind: "substituted", detail: `non-object content part of type ${typeof part}` });
    return opaquePart(PROTOCOL, "non-object", part);
  }
  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return { kind: "text", text: asString(part.text) ?? "" };
    case "input_image": {
      // 实测 image_url 是**裸字符串**（可能是 data: URL），不是 Chat 那样的嵌套对象。
      const media = parseImageBlob({ url: part.image_url });
      if (media === null) {
        losses.record({ path, kind: "substituted", detail: "input_image without a usable image_url" });
        return opaquePart(PROTOCOL, "input_image", part);
      }
      return { kind: "image", media };
    }
    case "input_file":
    case "output_refusal":
    default:
      losses.record({
        path, kind: "degraded",
        detail: `unmodelled responses content part '${String(part.type)}' boxed as opaque`,
      });
      return opaquePart(PROTOCOL, String(part.type ?? "unknown"), part);
  }
}

function decodeContent(content: unknown, path: string, losses: LossRecorder): IRPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content.length === 0 ? [] : [textPart(content)];
  if (Array.isArray(content)) return content.map((part, i) => decodeContentPart(part, `${path}[${i}]`, losses));
  losses.record({ path, kind: "substituted", detail: `content is ${typeof content}` });
  return [opaquePart(PROTOCOL, "content", content)];
}

/** `reasoning` item：`summary` 是可见摘要，`encrypted_content` 是回传用的不透明凭据。 */
function decodeReasoningItem(item: Record<string, unknown>, path: string, losses: LossRecorder): IRPart[] {
  const parts: IRPart[] = [];
  if (Array.isArray(item.summary)) {
    for (const entry of item.summary) {
      const text = typeof entry === "string" ? entry : isRecord(entry) ? asString(entry.text) : null;
      if (text !== null && text.length > 0) parts.push({ kind: "thinking", text });
    }
  }
  const encrypted = asString(item.encrypted_content);
  if (encrypted !== null && encrypted.length > 0) parts.push({ kind: "redactedThinking", data: encrypted });
  if (parts.length === 0) {
    losses.record({ path, kind: "dropped", detail: "reasoning item carried neither summary nor encrypted_content" });
  }
  return parts;
}

interface DecodedItem {
  readonly role: "user" | "assistant" | "system";
  readonly parts: readonly IRPart[];
}

function decodeItem(item: unknown, path: string, losses: LossRecorder): DecodedItem | null {
  if (typeof item === "string") return { role: "user", parts: [textPart(item)] };
  if (!isRecord(item)) {
    losses.record({ path, kind: "dropped", detail: "non-object input item" });
    return null;
  }
  // 没有 type 的 item 按 message 处理：Responses 允许省略 type。
  const type = asString(item.type) ?? (item.role !== undefined ? "message" : null);

  switch (type) {
    case "message": {
      const role = asString(item.role);
      const parts = decodeContent(item.content, `${path}.content`, losses);
      // developer / system 都是系统提示载体，归位到 conversation.system。
      if (role === "developer" || role === "system") return { role: "system", parts };
      if (role === "assistant") return { role: "assistant", parts };
      return { role: "user", parts };
    }

    case "function_call": {
      const callId = asString(item.call_id) ?? asString(item.id);
      const name = asString(item.name);
      if (callId === null || name === null) {
        losses.record({ path, kind: "substituted", detail: "function_call without call_id or name" });
        return { role: "assistant", parts: [opaquePart(PROTOCOL, "function_call", item)] };
      }
      // `namespace` 是**结构化**分组字段（codex rollout 实测），不是名字前缀。
      const group = asString(item.namespace);
      const ref: IRToolRef = { group, name };
      const argumentsText = asString(item.arguments) ?? "";
      let parsed: unknown;
      try { parsed = argumentsText.length === 0 ? {} : JSON.parse(argumentsText); } catch { parsed = undefined; }
      if (!isRecord(parsed)) {
        losses.record({
          path: `${path}.arguments`, kind: "degraded",
          detail: "function_call arguments are not a JSON object; preserved as freeform text input",
        });
      }
      return {
        role: "assistant",
        parts: [{
          kind: "toolCall",
          call: isRecord(parsed)
            ? { id: callId, toolRef: ref, input: { kind: "json", value: parsed } }
            : { id: callId, toolRef: ref, input: { kind: "text", text: argumentsText } },
        }],
      };
    }

    case "custom_tool_call": {
      const callId = asString(item.call_id) ?? asString(item.id);
      const name = asString(item.name);
      if (callId === null || name === null) {
        losses.record({ path, kind: "substituted", detail: "custom_tool_call without call_id or name" });
        return { role: "assistant", parts: [opaquePart(PROTOCOL, "custom_tool_call", item)] };
      }
      // custom 工具的入参是**自由文本**，不是 JSON —— 这是 freeform 入参的原生形态。
      return {
        role: "assistant",
        parts: [{
          kind: "toolCall",
          call: { id: callId, toolRef: { group: null, name }, input: { kind: "text", text: asString(item.input) ?? "" } },
        }],
      };
    }

    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = asString(item.call_id);
      if (callId === null) {
        losses.record({ path, kind: "dropped", detail: `${type} without call_id cannot be correlated` });
        return null;
      }
      const output = item.output;
      const parts = typeof output === "string"
        ? (output.length === 0 ? [] : [textPart(output)])
        : decodeContent(output, `${path}.output`, losses);
      // Responses 的结果项没有独立的错误标志；状态在 item.status 上（实测见于 custom_tool_call）。
      const status = asString(item.status) === "failed" ? "error" as const : "ok" as const;
      return { role: "user", parts: [{ kind: "toolResult", result: { callId, parts, status } }] };
    }

    case "reasoning":
      return { role: "assistant", parts: decodeReasoningItem(item, path, losses) };

    default:
      losses.record({
        path, kind: "degraded",
        detail: `unmodelled responses input item '${String(type)}' boxed as opaque`,
      });
      return { role: "assistant", parts: [opaquePart(PROTOCOL, String(type ?? "unknown"), item)] };
  }
}

function decodeTool(
  tool: unknown, path: string, group: string | null, losses: LossRecorder,
): { readonly tools: readonly IRTool[]; readonly group?: IRToolGroup } {
  if (!isRecord(tool)) {
    losses.record({ path, kind: "dropped", detail: "non-object tool definition" });
    return { tools: [] };
  }
  const type = asString(tool.type);

  // namespace 是结构化分组（实测 `{type:'namespace', name, description, tools:[…]}`）。
  // 成员保留 group 归属，**不做名字拍平** —— 拍平会逼出一个平行的还原 Map。
  if (type === "namespace") {
    const name = asString(tool.name) ?? "";
    const members = Array.isArray(tool.tools) ? tool.tools : [];
    const decoded = members.flatMap((member, index) =>
      decodeTool(member, `${path}.tools[${index}]`, name, losses).tools);
    return {
      tools: decoded,
      group: { name, members: decoded.map((member) => member.ref.name) },
    };
  }

  const description = asString(tool.description) ?? "";
  const name = asString(tool.name);

  if (type !== null && type !== "function" && type !== "custom") {
    // 内建工具实测可以**没有 name**（`{type:'web_search', external_web_access:false}`）；
    // 以 type 兜底，否则整条工具会因缺名被丢掉。
    const { type: _type, name: _name, description: _description, ...config } = tool;
    return {
      tools: [{
        kind: "builtin", ref: { group, name: name ?? type }, builtin: type,
        ...(Object.keys(config).length === 0 ? {} : { config }),
      }],
    };
  }

  if (name === null) {
    losses.record({ path, kind: "dropped", detail: "tool definition without a name" });
    return { tools: [] };
  }
  const ref: IRToolRef = { group, name };
  const schema = isRecord(tool.parameters) ? tool.parameters : null;
  if (type === "custom" && schema === null) return { tools: [{ kind: "freeform", ref, description }] };
  if (schema === null) {
    losses.record({ path, kind: "degraded", detail: "function tool without parameters treated as freeform" });
    return { tools: [{ kind: "freeform", ref, description }] };
  }
  return {
    tools: [{
      kind: "function", ref, description, schema,
      ...(tool.strict === true ? { strict: true } : {}),
    }],
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
  if (isRecord(value)) {
    const name = asString(value.name);
    if (name !== null) return { kind: "specific", ref: { group: asString(value.namespace), name } };
  }
  losses.record({ path: "$.tool_choice", kind: "dropped", detail: "unrecognized tool_choice shape" });
  return null;
}

function decodeOutputFormat(body: Record<string, unknown>, losses: LossRecorder): IROutputFormat {
  const text = isRecord(body.text) ? body.text : null;
  const format = text !== null && isRecord(text.format) ? text.format : null;
  if (format === null) return { kind: "text" };
  if (format.type === "text") return { kind: "text" };
  if (format.type === "json_schema") {
    const schema = isRecord(format.schema) ? format.schema : null;
    if (schema === null) {
      losses.record({ path: "$.text.format.schema", kind: "dropped", detail: "json_schema format without schema" });
      return { kind: "text" };
    }
    const name = asString(format.name);
    return {
      kind: "jsonSchema", schema,
      ...(name === null ? {} : { name }),
      ...(format.strict === true ? { strict: true } : {}),
    };
  }
  losses.record({
    path: "$.text.format", kind: "degraded",
    detail: `response format '${String(format.type)}' has no schema equivalent in IR`,
  });
  return { kind: "text" };
}

export function readResponsesRequest(raw: unknown, traceId: string): ClientRequestReadResult {
  const losses = new LossRecorder();
  if (!isRecord(raw)) throw new TypeError("responses body must be a JSON object");
  const body = raw;

  const system: IRPart[] = [];
  // `instructions` 是 Responses 的系统提示载体（实测 32/80）。与 developer 消息同源。
  const instructions = asString(body.instructions);
  if (instructions !== null && instructions.length > 0) system.push(textPart(instructions));

  const turns: IRTurn[] = [];
  const rawInput = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  rawInput.forEach((item, index) => {
    const decoded = decodeItem(item, `$.input[${index}]`, losses);
    if (decoded === null) return;
    if (decoded.role === "system") { system.push(...decoded.parts); return; }
    turns.push({ role: decoded.role, parts: decoded.parts });
  });

  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools: IRTool[] = [];
  const groups: IRToolGroup[] = [];
  rawTools.forEach((tool, index) => {
    const decoded = decodeTool(tool, `$.tools[${index}]`, null, losses);
    tools.push(...decoded.tools);
    if (decoded.group !== undefined) groups.push(decoded.group);
  });

  const choice = decodeToolChoice(body.tool_choice, losses);
  const toolset: IRToolset = {
    tools, groups,
    choice: choice === null ? defaultValue<IRToolChoice>({ kind: "auto" }) : clientValue(choice),
    parallel: typeof body.parallel_tool_calls === "boolean"
      ? clientValue(body.parallel_tool_calls)
      : defaultValue(true),
  };

  const reasoningConfig = isRecord(body.reasoning) ? body.reasoning : null;
  const effort = reasoningConfig === null ? undefined : parseEffort(reasoningConfig.effort);
  const summary = reasoningConfig === null ? null : asString(reasoningConfig.summary);
  const display: IRReasoningDisplay =
    summary === "auto" || summary === "concise" || summary === "detailed" ? "summarized" : "full";
  const reasoning: IRReasoning = {
    mode: reasoningConfig === null ? "auto" : "enabled",
    display,
    ...(effort === undefined ? {} : { effort }),
  };

  const maxTokens = asFiniteNumber(body.max_output_tokens);
  const temperature = asFiniteNumber(body.temperature);
  const topP = asFiniteNumber(body.top_p);

  const intent: IRIntent = {
    reasoning: reasoningConfig === null ? defaultValue(reasoning) : clientValue(reasoning),
    outputFormat: clientValue(decodeOutputFormat(body, losses)),
    serviceTier: body.service_tier === "priority" ? clientValue("priority" as const) : defaultValue("standard" as const),
    sampling: {
      ...(temperature === null ? {} : { temperature: clientValue(temperature) }),
      ...(topP === null ? {} : { topP: clientValue(topP) }),
    },
    stopping: { ...(maxTokens === null ? {} : { maxOutputTokens: clientValue(maxTokens) }) },
    contextEdits: [],
    stream: body.stream === true ? clientValue(true) : defaultValue(false),
    identity: {},
  };

  const conversation = { system, turns: normalizeTurns(turns, losses), toolset };
  const partial = { traceId, protocol: PROTOCOL, model: asString(body.model) ?? "", conversation, intent };
  return { request: { ...partial, requires: deriveCapabilityNeeds(partial) }, losses: losses.drain() };
}
