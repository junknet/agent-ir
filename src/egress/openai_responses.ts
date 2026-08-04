/**
 * OpenAI Responses 出口：IR → wire（lower）+ 上游 SSE / JSON → IREvent（lift）。
 *
 * 面向的是**标准 `/v1/responses`**（`baseUrl` + `Authorization: Bearer`），不是 ChatGPT 的
 * 私有 codex 端点（`chatgpt.com/backend-api/codex/responses`，需要 `chatgpt-account-id` /
 * `originator` 头且 URL 固定，根本用不上 baseUrl/apiKey）。这个区分直接决定一个字段的归属：
 *
 *   标准端点   接受 `max_output_tokens`   →  `maxOutputTokens` 进 supports，照实下发
 *   codex 端点 拒收（400 "Unsupported parameter: max_output_tokens"）且无等价参数
 *              →  真接那个端点时它只能进 lossy 并记 dropped loss（见 agent-all-sdk-ts
 *                 codex_provider.ts:113 的实测注释）
 *
 * 两条轴上这个出口的**价值**在于它原生表达了 Anthropic 出口只能拍平的两件事：
 *   - 工具分组：定义侧 `{type:'namespace', name, tools:[…]}`，调用侧 `function_call.namespace`
 *     （codex rollout 实测 1176 条 function_call 里 872 条带 namespace，值形如 "collaboration"）
 *   - freeform 工具：`{type:'custom'}` 定义 + `custom_tool_call.input` 自由文本
 *     （rollout 实测 7901 条 custom_tool_call，apply_patch / exec 都走这条）
 * 因此两者都在 supports 而不是 lossy —— 这正是多接一个出口换来的东西。
 *
 * 与 Anthropic 出口最大的结构差异：`input` 是**扁平 item 序列**，工具调用/结果/推理各自
 * 是独立 item，靠 call_id 关联。IR 本来就是这个形态，所以这里不需要 `arrangeToolTurns`
 * 那种位置重排，只需要补全「调用必须有对应输出」这一条上游硬约束。
 */
import { iterateSse, tryParseJson } from "../ir/sse.ts";
import type {
  IRCapability, IREffort, IREgress, IREgressProfile, IREvent, IRLoss, UpstreamRequestBuildResult, IRPart, IRReasoningDisplay,
  IRRequest, IRStopReason, IRTool, IRUpstreamError, IRUsage,
} from "../ir/types.ts";

const PROVIDER = "openai_responses";

/**
 * 逐项都核对过真实报文或真实端点行为，没核对上的一律不进这个集合。
 *
 * toolGroup / toolFreeform / toolBuiltin 三项是这个出口独有的原生能力（见文件头）。
 * `document` 不在这里：`input_file` 在 80 条归档请求与 94 份 rollout 里**一次都没出现过**，
 * 拿不准的形状写进 supports 等于拿整条请求赌一个 400，所以它降级进 lossy 走文本占位。
 */
const SUPPORTED = [
  "stream", "nonStream", "systemPrompt", "multiTurn", "image",
  "thinking", "reasoningEffort",
  "toolFunction", "toolFreeform", "toolBuiltin", "toolGroup", "toolParallel", "toolChoiceSpecific",
  "structuredOutput", "maxOutputTokens", "temperature", "topP", "serviceTier",
] as const satisfies readonly IRCapability[];

/**
 * 能承载但有损。每一项都在 `lower` 里对应一处真实的降级动作 + 一条 IRLoss：
 *
 *   thinkingSignature  Anthropic 的签名思考块在 Responses 没有载体（这里的凭据是
 *                      `reasoning.encrypted_content`），签名只能丢
 *   reasoningBudget    Responses 没有 token 预算参数，只能折算成 effort 档
 *   document           无实测形状，退化成文本占位符，正文不到达模型
 *   toolResultImage    `function_call_output.output` 实测只见过字符串与 input_text 数组
 *                      （rollout 7901+1176 条无一例外），图片退化成占位文本
 *   toolResultError    输出 item 没有 is_error 之类的错误位，只能把错误性写进正文
 *   cacheBreakpoint    Responses 自动缓存（prompt_cache_key），没有显式断点
 *   contextEdit        没有等价的历史处置指令，只能整条丢
 *   stopSequences      `/v1/responses` 没有 stop 参数（Chat Completions 才有）
 *   topK               Responses 只有 temperature / top_p
 *
 * 元素类型是 `Exclude<IRCapability, 已 supports 的>`：与 supports 重叠会被编译期挡下 ——
 * 重叠时准入先命中 supports 直接放行，上面逐条写下的降级动作与 IRLoss 就一条都不会发生。
 */
const LOSSY = [
  "thinkingSignature", "reasoningBudget", "document", "toolResultImage", "toolResultError",
  "cacheBreakpoint", "contextEdit", "stopSequences", "topK",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

export interface ResponsesUpstreamOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

class UpstreamRequestLosses {
  readonly #losses: IRLoss[] = [];
  record(loss: Omit<IRLoss, "stage" | "provider">): void {
    this.#losses.push({ stage: "egress", provider: PROVIDER, ...loss });
  }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
}

type WireItem = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dataUrl(part: Extract<IRPart, { kind: "image" | "document" }>): string {
  return part.media.source.kind === "url"
    ? part.media.source.url
    : `data:${part.media.mediaType};base64,${part.media.source.data}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// lower
// ═══════════════════════════════════════════════════════════════════════════

/** 一个工具调用是 function 还是 custom，决定了它的**输出 item 类型**必须配对。 */
type CallKind = "function" | "custom";

/**
 * 内容 part → message item 的 content 元素。
 * `role` 参与判定：assistant 的 content 只接受 `output_text`，图片之类只能出现在输入侧。
 */
function lowerContentPart(
  part: IRPart, role: "user" | "assistant" | "developer", path: string, losses: UpstreamRequestLosses,
): WireItem | null {
  switch (part.kind) {
    case "text":
      if (part.text.length === 0) return null;
      return role === "assistant"
        ? { type: "output_text", text: part.text, annotations: [] }
        : { type: "input_text", text: part.text };
    case "image":
      if (role === "assistant") {
        losses.record({ path, kind: "dropped", detail: "assistant message content accepts output_text only; image dropped" });
        return null;
      }
      // 实测 input_image.image_url 是**裸字符串**（可能是 data: URL），不是嵌套对象。
      return { type: "input_image", image_url: dataUrl(part) };
    case "document":
      losses.record({
        path, kind: "dropped",
        detail: `document (${part.media.mediaType}) replaced by a text marker: the Responses input_file shape is not present in any archived request or rollout, and guessing it costs the whole request a 400`,
      });
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: `[gateway: a ${part.media.mediaType} document was attached here but this upstream route cannot carry it; its contents are unavailable]`,
        ...(role === "assistant" ? { annotations: [] } : {}),
      };
    case "opaque":
      // 同源原样放回（无损往返）；异源没法翻译，丢弃留痕。
      if (part.origin === "openai_responses" && isRecord(part.raw)) return part.raw;
      losses.record({
        path, kind: "dropped",
        detail: `opaque part from ${part.origin} (${part.tag}) has no Responses content representation`,
      });
      return null;
    case "thinking":
    case "redactedThinking":
    case "toolCall":
    case "toolResult":
      // 这四种在 Responses 里是**独立 item**，不是 message 的 content，由调用方分流。
      losses.record({ path, kind: "dropped", detail: `'${part.kind}' is not a message content shape and was not routed to its own item` });
      return null;
  }
}

/** 工具结果 parts → 输出 item 的 `output`。实测形态：字符串，或 `input_text` 数组。 */
function lowerToolOutput(
  parts: readonly IRPart[], status: "ok" | "error" | "missing", path: string, losses: UpstreamRequestLosses,
): Array<WireItem> {
  const blocks: WireItem[] = [];
  parts.forEach((part, index) => {
    const childPath = `${path}.result.parts[${index}]`;
    if (part.kind === "text") {
      if (part.text.length > 0) blocks.push({ type: "input_text", text: part.text });
      return;
    }
    if (part.kind === "image") {
      // rollout 里 7901 条 custom_tool_call_output + 1176 条 function_call_output 的 output
      // 只有 string 与 input_text 数组两种形态，没有一条带图片。塞进去可能 400，塞 data URL
      // 文本则是几十万 token 的哑弹 —— 两者都不如一个模型看得懂的占位符。
      losses.record({
        path: childPath, kind: "dropped",
        detail: `tool result image (${part.media.mediaType}) replaced by a text marker: Responses tool output carries text parts only`,
      });
      blocks.push({ type: "input_text", text: `[gateway: tool returned a ${part.media.mediaType} image; this upstream route cannot carry it]` });
      return;
    }
    losses.record({ path: childPath, kind: "dropped", detail: `'${part.kind}' has no representation inside a Responses tool output` });
  });
  if (status === "error") {
    // 输出 item 上没有 is_error 之类的错误位。不标记的话模型会当成执行成功 —— 那正是
    // 「假装工具返回空」那类最贵的静默失败，所以把错误性写进正文并留痕。
    losses.record({
      path, kind: "degraded",
      detail: "Responses tool output has no error flag; the failure is marked inside the output text instead",
    });
    blocks.unshift({ type: "input_text", text: "[gateway: this tool call failed]" });
  }
  if (blocks.length === 0) blocks.push({ type: "input_text", text: "" });
  return blocks;
}

function lowerToolCallItem(part: Extract<IRPart, { kind: "toolCall" }>, path: string, losses: UpstreamRequestLosses): WireItem {
  const { call } = part;
  if (call.input.kind === "text") {
    // freeform 的原生形态。实测 custom_tool_call 的键集是 {type,id,status,call_id,name,input}，
    // **没有 namespace** —— 分组的 freeform 工具只能在调用侧丢掉分组。
    if (call.toolRef.group !== null) {
      losses.record({
        path, kind: "degraded",
        detail: `custom_tool_call carries no namespace field (verified over 7901 rollout items); group '${call.toolRef.group}' is not recoverable from the call item`,
      });
    }
    return { type: "custom_tool_call", call_id: call.id, name: call.toolRef.name, input: call.input.text };
  }
  return {
    type: "function_call",
    call_id: call.id,
    name: call.toolRef.name,
    // 分组是**结构化字段**，不是名字前缀。这是这个出口相对 Anthropic 出口的核心增益。
    ...(call.toolRef.group === null ? {} : { namespace: call.toolRef.group }),
    arguments: JSON.stringify(call.input.value),
  };
}

/**
 * 推理 item。ingress 把一条 `reasoning` 拆成若干 thinking part + 一个 redactedThinking part，
 * 这里把连续的一段合回一个 item，`encrypted_content` 原样回传 —— 这是 store=false 时
 * 让上游认得自己上一轮思考的唯一凭据。
 *
 * **没有 encrypted_content 就不发**：rollout 里 10204 条 reasoning 无一例外都带它，
 * summary-only 的形状从未在真实报文里出现过，赌它能过等于赌整条请求。跨协议进来的
 * Anthropic 签名思考正好落在这一支，丢弃并留痕（codex_provider 的做法也是整段不译）。
 */
function lowerReasoningRun(run: readonly IRPart[], path: string, losses: UpstreamRequestLosses): WireItem | null {
  const summary: WireItem[] = [];
  let encrypted: string | null = null;
  for (const part of run) {
    if (part.kind === "thinking") {
      if (part.signature !== undefined) {
        losses.record({
          path, kind: "dropped",
          detail: "thinking signature has no carrier on Responses; the round-trip credential here is reasoning.encrypted_content",
        });
      }
      if (part.text.length > 0) summary.push({ type: "summary_text", text: part.text });
      continue;
    }
    if (part.kind === "redactedThinking") encrypted = part.data;
  }
  if (encrypted === null) {
    losses.record({
      path, kind: "dropped",
      detail: "reasoning item dropped: without encrypted_content it cannot be replayed on this endpoint (store=false), and a summary-only reasoning item has never appeared in real traffic",
    });
    return null;
  }
  return { type: "reasoning", summary, encrypted_content: encrypted };
}

interface LoweredConversation {
  readonly instructions: string;
  readonly items: readonly WireItem[];
}

function lowerConversation(request: IRRequest, losses: UpstreamRequestLosses): LoweredConversation {
  const { conversation } = request;
  const items: WireItem[] = [];
  const callKinds = new Map<string, CallKind>();
  let cacheBreakpoints = 0;

  const countCache = (part: IRPart): void => {
    if (part.cacheBreakpoint !== undefined) cacheBreakpoints += 1;
    if (part.kind === "toolResult") part.result.parts.forEach(countCache);
  };
  conversation.system.forEach(countCache);
  for (const turn of conversation.turns) turn.parts.forEach(countCache);

  // ── system → instructions（+ 非文本部分退到 developer message item） ──────
  const instructionLines: string[] = [];
  const developerContent: WireItem[] = [];
  conversation.system.forEach((part, index) => {
    const path = `$.conversation.system[${index}]`;
    if (part.kind === "text") {
      if (part.text.length > 0) instructionLines.push(part.text);
      return;
    }
    const block = lowerContentPart(part, "developer", path, losses);
    if (block !== null) developerContent.push(block);
  });
  if (developerContent.length > 0) {
    // 实测 codex 的系统提示同时走 `instructions` 字符串与 `role:'developer'` 的 message item，
    // 两者共存是常态，所以非文本部分不必被迫塞进 instructions。
    items.push({ type: "message", role: "developer", content: developerContent });
  }

  // ── turns → 扁平 item 序列 ───────────────────────────────────────────────
  for (const [turnIndex, turn] of conversation.turns.entries()) {
    let pending: WireItem[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      items.push({ type: "message", role: turn.role, content: pending });
      pending = [];
    };
    let reasoningRun: IRPart[] = [];
    const flushReasoning = (path: string): void => {
      if (reasoningRun.length === 0) return;
      const item = lowerReasoningRun(reasoningRun, path, losses);
      reasoningRun = [];
      if (item !== null) items.push(item);
    };

    for (const [partIndex, part] of turn.parts.entries()) {
      const path = `$.conversation.turns[${turnIndex}].parts[${partIndex}]`;

      if (part.kind === "thinking" || part.kind === "redactedThinking") {
        flush();
        reasoningRun.push(part);
        continue;
      }
      flushReasoning(path);

      if (part.kind === "toolCall") {
        flush();
        callKinds.set(part.call.id, part.call.input.kind === "text" ? "custom" : "function");
        items.push(lowerToolCallItem(part, path, losses));
        continue;
      }
      if (part.kind === "toolResult") {
        flush();
        const kind = callKinds.get(part.result.callId) ?? "function";
        items.push({
          type: kind === "custom" ? "custom_tool_call_output" : "function_call_output",
          call_id: part.result.callId,
          output: lowerToolOutput(part.result.parts, part.result.status, path, losses),
        });
        continue;
      }
      const block = lowerContentPart(part, turn.role, path, losses);
      if (block !== null) pending.push(block);
    }
    flushReasoning(`$.conversation.turns[${turnIndex}]`);
    flush();
  }

  if (cacheBreakpoints > 0) {
    losses.record({
      path: "$.conversation", kind: "dropped",
      detail: `${cacheBreakpoints} ephemeral cache breakpoint(s) dropped; Responses caches automatically (prompt_cache_key) and has no explicit breakpoint`,
    });
  }

  return { instructions: instructionLines.join("\n\n"), items: reconcileToolItems(items, losses) };
}

/**
 * 补全上游的唯一硬约束：**每个 function_call / custom_tool_call 都必须有配对的输出 item**
 * （缺了 400 "No tool output found for function call"，多了同样 400）。
 *
 * 与 Anthropic 出口的区别在于这里**不重排位置**：Responses 的 item 序列没有「结果必须紧邻
 * 且最前」那套排列规则，IR 的顺序直接就是合法顺序，只需要补洞和去孤儿。
 */
function reconcileToolItems(items: readonly WireItem[], losses: UpstreamRequestLosses): WireItem[] {
  const isCall = (item: WireItem): boolean => item.type === "function_call" || item.type === "custom_tool_call";
  const isOutput = (item: WireItem): boolean =>
    item.type === "function_call_output" || item.type === "custom_tool_call_output";

  const callIds = new Set<string>();
  const answered = new Set<string>();
  for (const item of items) {
    const callId = asString(item.call_id);
    if (callId === null) continue;
    if (isCall(item)) callIds.add(callId);
    else if (isOutput(item)) answered.add(callId);
  }

  const out: WireItem[] = [];
  for (const item of items) {
    const callId = asString(item.call_id);
    if (isOutput(item) && (callId === null || !callIds.has(callId))) {
      losses.record({
        path: "$.conversation.turns", kind: "dropped",
        detail: `orphan tool result ${callId ?? "<no call_id>"} has no matching call and is rejected upstream`,
      });
      continue;
    }
    out.push(item);
    if (!isCall(item) || callId === null || answered.has(callId)) continue;
    // 悬空调用：客户端历史缺了结果。措辞要让模型知道结果不可信 —— 假装工具返回空
    // 会让 agent 以为命令执行成功且无输出。
    out.push({
      type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
      call_id: callId,
      output: [{ type: "input_text", text: "[gateway: tool result missing from client history; treat as unknown]" }],
    });
    losses.record({
      path: "$.conversation.turns", kind: "substituted",
      detail: `dangling tool call ${callId} filled with an explicit placeholder output`,
    });
  }
  return out;
}

function lowerTools(request: IRRequest, losses: UpstreamRequestLosses): WireItem[] {
  const { toolset } = request.conversation;

  const lowerOne = (tool: IRTool, index: number): WireItem => {
    const path = `$.conversation.toolset.tools[${index}]`;
    if (tool.kind === "function") {
      if (tool.deferLoading === true) {
        losses.record({ path, kind: "dropped", detail: "defer_loading is an Anthropic-only hint with no Responses equivalent" });
      }
      return {
        type: "function", name: tool.ref.name, description: tool.description,
        strict: tool.strict === true, parameters: tool.schema,
      };
    }
    if (tool.kind === "freeform") {
      // 原生 freeform：不包 schema、不塞单字段对象。Anthropic 出口在这里必须降级，这里不必。
      return { type: "custom", name: tool.ref.name, description: tool.description };
    }
    // 内建工具实测可以**没有 name**（`{type:'web_search', external_web_access:false}`）。
    return {
      type: tool.builtin,
      ...(tool.ref.name === tool.builtin ? {} : { name: tool.ref.name }),
      ...(tool.config ?? {}),
    };
  };

  const top: WireItem[] = [];
  const grouped = new Map<string, WireItem[]>();
  toolset.tools.forEach((tool, index) => {
    const wire = lowerOne(tool, index);
    const group = tool.ref.group;
    if (group === null) { top.push(wire); return; }
    const bucket = grouped.get(group);
    if (bucket === undefined) grouped.set(group, [wire]);
    else bucket.push(wire);
  });

  // 分组是结构，不是命名约定：`{type:'namespace', name, tools:[…]}` 是实测形态（归档 9 条）。
  for (const [name, members] of grouped) top.push({ type: "namespace", name, tools: members });
  return top;
}

function lowerToolChoice(request: IRRequest): unknown {
  const { toolset } = request.conversation;
  const choice = toolset.choice.value;
  if (choice.kind === "auto") return "auto";
  if (choice.kind === "none") return "none";
  if (choice.kind === "required") return "required";
  const target = toolset.tools.find((tool) =>
    tool.ref.name === choice.ref.name && tool.ref.group === choice.ref.group);
  return {
    type: target?.kind === "freeform" ? "custom" : "function",
    name: choice.ref.name,
    ...(choice.ref.group === null ? {} : { namespace: choice.ref.group }),
  };
}

const EFFORT_WIRE: Readonly<Record<IREffort, string>> = {
  minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
};

/** budget → effort 档。Responses 没有 token 预算参数，只能折算，边界取自常见 thinking 档位。 */
function effortFromBudget(budgetTokens: number): IREffort {
  if (budgetTokens <= 1024) return "minimal";
  if (budgetTokens <= 4096) return "low";
  if (budgetTokens <= 16384) return "medium";
  return "high";
}

const SUMMARY_WIRE: Readonly<Record<IRReasoningDisplay, string | null>> = {
  // 不设 summary 时上游默认不返回摘要，与 hidden 精确对应，因此这一支**不是**损失。
  hidden: null, summarized: "auto", full: "detailed",
};

function lowerReasoningConfig(request: IRRequest, losses: UpstreamRequestLosses): Record<string, unknown> | null {
  const reasoning = request.intent.reasoning.value;
  if (reasoning.mode === "disabled") {
    losses.record({
      path: "$.intent.reasoning", kind: "dropped",
      detail: "Responses has no verified switch to turn reasoning off on a reasoning model; the request is sent without a reasoning field and the upstream decides",
    });
    return null;
  }

  let effort = reasoning.effort;
  if (effort !== undefined && EFFORT_WIRE[effort] !== effort) {
    losses.record({
      path: "$.intent.reasoning.effort", kind: "substituted",
      detail: `effort '${effort}' is not an accepted Responses value; clamped to '${EFFORT_WIRE[effort]}'`,
    });
  }
  if (reasoning.budgetTokens !== undefined) {
    if (effort === undefined) {
      effort = effortFromBudget(reasoning.budgetTokens);
      losses.record({
        path: "$.intent.reasoning.budgetTokens", kind: "substituted",
        detail: `Responses has no reasoning token budget; budget_tokens=${reasoning.budgetTokens} converted to effort '${effort}'`,
      });
    } else {
      losses.record({
        path: "$.intent.reasoning.budgetTokens", kind: "dropped",
        detail: `Responses has no reasoning token budget; budget_tokens=${reasoning.budgetTokens} dropped in favour of the explicit effort '${effort}'`,
      });
    }
  }
  if (reasoning.display === "full") {
    losses.record({
      path: "$.intent.reasoning.display", kind: "degraded",
      detail: "Responses only ever returns a reasoning summary; the full reasoning text is never exposed",
    });
  }

  const summary = SUMMARY_WIRE[reasoning.display];
  const config: Record<string, unknown> = {};
  if (effort !== undefined) config.effort = EFFORT_WIRE[effort];
  if (summary !== null) config.summary = summary;
  return Object.keys(config).length === 0 ? null : config;
}

export function createResponsesUpstream(options: ResponsesUpstreamOptions): IREgress {
  const profile: IREgressProfile = {
    provider: PROVIDER,
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
  };

  return {
    profile,

    async writeUpstreamRequest(request: IRRequest): Promise<UpstreamRequestBuildResult> {
      const losses = new UpstreamRequestLosses();
      const { conversation, intent } = request;
      const { instructions, items } = lowerConversation(request, losses);
      const tools = lowerTools(request, losses);
      const reasoning = lowerReasoningConfig(request, losses);

      if (intent.stopping.stopSequences !== undefined) {
        losses.record({
          path: "$.intent.stopping.stopSequences", kind: "dropped",
          detail: "/v1/responses has no stop parameter (only Chat Completions does); stop sequences are not enforced upstream",
        });
      }
      if (intent.sampling.topK !== undefined) {
        losses.record({
          path: "$.intent.sampling.topK", kind: "dropped",
          detail: "Responses exposes temperature and top_p only; top_k has no equivalent",
        });
      }
      if (intent.contextEdits.length > 0) {
        losses.record({
          path: "$.intent.contextEdits", kind: "dropped",
          detail: `${intent.contextEdits.length} context edit instruction(s) dropped; Responses has no history-editing directive (truncation:'auto' is not equivalent)`,
        });
      }

      const outputFormat = intent.outputFormat.value;
      let text: Record<string, unknown> | undefined;
      if (outputFormat.kind === "jsonSchema") {
        if (outputFormat.name === undefined) {
          // json_schema 格式上游要求带 name，缺了直接 400。补一个并留痕。
          losses.record({
            path: "$.intent.outputFormat", kind: "substituted",
            detail: "Responses requires a name on text.format.json_schema; gateway supplied 'response'",
          });
        }
        text = {
          format: {
            type: "json_schema",
            name: outputFormat.name ?? "response",
            schema: outputFormat.schema,
            ...(outputFormat.strict === true ? { strict: true } : {}),
          },
        };
      }

      const body: Record<string, unknown> = {
        model: options.model,
        input: items,
        stream: intent.stream.value,
        // 网关不替客户端在上游留存会话；store=false 时加密思考必须显式 include 才回传。
        store: false,
        ...(instructions.length === 0 ? {} : { instructions }),
        ...(tools.length === 0 ? {} : { tools }),
        ...(tools.length === 0 || conversation.toolset.choice.source !== "client"
          ? {} : { tool_choice: lowerToolChoice(request) }),
        ...(tools.length === 0 ? {} : { parallel_tool_calls: conversation.toolset.parallel.value }),
        ...(reasoning === null ? {} : { reasoning, include: ["reasoning.encrypted_content"] }),
        ...(text === undefined ? {} : { text }),
        // 标准 /v1/responses 接受 max_output_tokens；私有 codex 端点会 400 拒收（文件头）。
        ...(intent.stopping.maxOutputTokens === undefined
          ? {} : { max_output_tokens: intent.stopping.maxOutputTokens.value }),
        ...(intent.sampling.temperature === undefined ? {} : { temperature: intent.sampling.temperature.value }),
        ...(intent.sampling.topP === undefined ? {} : { top_p: intent.sampling.topP.value }),
        ...(intent.serviceTier.source === "client" && intent.serviceTier.value === "priority"
          ? { service_tier: "priority" } : {}),
        // 实测 prompt_cache_key == 会话 uuid，是这个端点唯一的缓存抓手。
        ...(intent.identity.sessionId === undefined ? {} : { prompt_cache_key: intent.identity.sessionId }),
      };

      return {
        wire: {
          url: `${options.baseUrl.replace(/\/$/u, "")}/responses`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            ...(intent.stream.value ? { accept: "text/event-stream" } : {}),
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        },
        losses: losses.drain(),
      };
    },

    readUpstreamResponse(response: Response): AsyncIterable<IREvent> {
      return liftResponsesStream(response);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// lift
// ═══════════════════════════════════════════════════════════════════════════

function mapUpstreamError(payload: unknown, httpStatus: number | null): IRUpstreamError {
  const holder = isRecord(payload) ? payload : {};
  const inner = isRecord(holder.error) ? holder.error : holder;
  const code = asString(inner.code) ?? "";
  const type = asString(inner.type) ?? "";
  const message = asString(inner.message) ?? (typeof payload === "string" && payload.length > 0 ? payload : "upstream error");
  const tag = `${code} ${type}`.toLowerCase();

  const kind: IRUpstreamError["kind"] =
    // 一天 126 次的那条：context_length_exceeded 既可能带 4xx 回来，也可能作为流内事件到达。
    tag.includes("context_length_exceeded") || /context.{0,12}length|maximum context|too many tokens/iu.test(message)
      ? "contextLengthExceeded"
    : tag.includes("insufficient_quota") || tag.includes("billing") || /quota/iu.test(message)
      ? "quotaExhausted"
    : tag.includes("rate_limit") || httpStatus === 429
      ? "rateLimited"
    : tag.includes("content_policy") || tag.includes("content_filter")
      ? "contentPolicy"
    : tag.includes("invalid_api_key") || tag.includes("authentication") || tag.includes("permission")
      || httpStatus === 401 || httpStatus === 403
      ? "permissionDenied"
    : tag.includes("server_error") || tag.includes("service_unavailable") || tag.includes("overloaded")
      || (httpStatus !== null && httpStatus >= 500)
      ? "upstreamUnavailable"
    : tag.includes("invalid_request") || tag.includes("invalid_prompt") || tag.includes("not_found")
      || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500)
      ? "invalidRequest"
    : "unknown";

  return {
    kind, httpStatus, message,
    retryable: kind === "rateLimited" || kind === "upstreamUnavailable",
    raw: payload,
  };
}

/**
 * usage 口径转换。**Responses 的 `input_tokens` 含 `input_tokens_details.cached_tokens`**
 * （实测 18661 里 cached 17792），IR 用 Anthropic 语义（input 不含缓存），所以必须先减出来。
 * 不减的话缓存命中会被双倍计入输入，harness 的上下文压缩阈值全部算错。
 */
function usageFrom(raw: unknown): IRUsage | null {
  if (!isRecord(raw)) return null;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const total = num(raw.input_tokens) ?? 0;
  const cached = num(inputDetails.cached_tokens);
  const reasoning = num(outputDetails.reasoning_tokens);
  return {
    inputTokens: cached === undefined ? total : Math.max(total - cached, 0),
    outputTokens: num(raw.output_tokens) ?? 0,
    // 三态：Responses 不报缓存写入量，所以 cacheWriteTokens 保持 undefined（= 上游不支持）。
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function stopReasonFrom(responseObject: unknown, sawToolCall: boolean): IRStopReason {
  const holder = isRecord(responseObject) ? responseObject : {};
  const incomplete = isRecord(holder.incomplete_details) ? holder.incomplete_details : null;
  if (incomplete !== null && asString(incomplete.reason) === "max_output_tokens") return "maxTokens";
  if (asString(holder.status) === "incomplete") return "aborted";
  return sawToolCall ? "toolUse" : "endTurn";
}

function toolCallPart(item: Record<string, unknown>, freeform: boolean): IRPart | null {
  const id = asString(item.call_id) ?? asString(item.id);
  const name = asString(item.name);
  if (id === null || name === null) return null;
  return {
    kind: "toolCall",
    call: {
      id,
      toolRef: { group: asString(item.namespace), name },
      input: freeform ? { kind: "text", text: "" } : { kind: "json", value: {} },
    },
  };
}

/**
 * 非流式 JSON 的 output item → 等价事件序列。
 * 合成而不是另开一条路径：下游 encode 不需要区分流式与非流式（同 Anthropic 出口的做法）。
 */
function* synthesizeOutput(output: unknown, startIndex: number): Generator<IREvent, { index: number; sawToolCall: boolean }> {
  let index = startIndex;
  let sawToolCall = false;
  if (!Array.isArray(output)) return { index, sawToolCall };

  const emit = function* (part: IRPart): Generator<IREvent> {
    yield { kind: "partStart", index, part };
    yield { kind: "partEnd", index };
    index += 1;
  };

  for (const raw of output) {
    if (!isRecord(raw)) { yield { kind: "unhandled", rawType: "output_item", raw }; continue; }
    switch (raw.type) {
      case "message": {
        const content = Array.isArray(raw.content) ? raw.content : [];
        for (const block of content) {
          if (!isRecord(block)) { yield { kind: "unhandled", rawType: "output_content", raw: block }; continue; }
          if (block.type === "output_text" || block.type === "refusal") {
            yield* emit({ kind: "text", text: asString(block.text) ?? asString(block.refusal) ?? "" });
            continue;
          }
          yield { kind: "unhandled", rawType: `output_content:${String(block.type)}`, raw: block };
        }
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(raw.summary) ? raw.summary : [];
        for (const entry of summary) {
          const text = typeof entry === "string" ? entry : isRecord(entry) ? asString(entry.text) : null;
          if (text !== null && text.length > 0) yield* emit({ kind: "thinking", text });
        }
        const encrypted = asString(raw.encrypted_content);
        if (encrypted !== null && encrypted.length > 0) yield* emit({ kind: "redactedThinking", data: encrypted });
        break;
      }
      case "function_call": {
        const part = toolCallPart(raw, false);
        if (part === null || part.kind !== "toolCall") { yield { kind: "unhandled", rawType: "function_call", raw }; break; }
        sawToolCall = true;
        const args = asString(raw.arguments) ?? "";
        yield { kind: "partStart", index, part };
        if (args.length > 0) yield { kind: "partDelta", index, delta: { kind: "toolInputJson", json: args } };
        yield { kind: "partEnd", index };
        index += 1;
        break;
      }
      case "custom_tool_call": {
        const part = toolCallPart(raw, true);
        if (part === null || part.kind !== "toolCall") { yield { kind: "unhandled", rawType: "custom_tool_call", raw }; break; }
        sawToolCall = true;
        const input = asString(raw.input) ?? "";
        yield { kind: "partStart", index, part };
        if (input.length > 0) yield { kind: "partDelta", index, delta: { kind: "toolInputText", text: input } };
        yield { kind: "partEnd", index };
        index += 1;
        break;
      }
      default:
        // 不变量 4：web_search_call / image_generation_call / local_shell_call 这些没建模的
        // item 是流里的元素，不是可以跳过的噪音。
        yield { kind: "unhandled", rawType: `output_item:${String(raw.type)}`, raw };
    }
  }
  return { index, sawToolCall };
}

/** 流式里 IR part 索引的分配：一个 `output_index` 下可能有多个内容/摘要片段，键要带上它们。 */
class PartIndexer {
  #next = 0;
  readonly #byKey = new Map<string, number>();
  readonly toolBuffers = new Map<number, string>();

  has(key: string): boolean { return this.#byKey.has(key); }
  get(key: string): number | undefined { return this.#byKey.get(key); }
  allocate(key: string): number {
    const existing = this.#byKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.#next++;
    this.#byKey.set(key, index);
    return index;
  }
  /** 与某个 output_index 相关的全部片段，用于 output_item.done 时统一收尾。 */
  indicesFor(outputIndex: number): number[] {
    const prefix = `${outputIndex}:`;
    return [...this.#byKey.entries()].filter(([key]) => key.startsWith(prefix)).map(([, index]) => index);
  }
  freshIndex(): number { return this.#next++; }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function* liftResponsesStream(response: Response): AsyncGenerator<IREvent> {
  // 非 2xx：整体读出来当一次性错误，不进 SSE 解析。
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapUpstreamError(tryParseJson(text) ?? text, response.status) };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    yield* liftResponsesJson(response);
    return;
  }

  const indexer = new PartIndexer();
  let sawTerminal = false;
  let sawToolCall = false;
  let started = false;

  for await (const frame of iterateSse(response)) {
    const payload = tryParseJson<Record<string, unknown>>(frame.data);
    if (payload === null || !isRecord(payload)) {
      // data 段解析不出 JSON：上游换了编码，或流被截断在半个事件上。丢掉它就等于它从没存在过。
      yield { kind: "unhandled", rawType: frame.event ?? "<unparseable>", raw: frame.data };
      continue;
    }
    const type = asString(payload.type) ?? frame.event ?? "";
    const outputIndex = numberOr(payload.output_index, 0);

    switch (type) {
      case "response.created":
      case "response.in_progress": {
        if (started) break;
        started = true;
        const envelope = isRecord(payload.response) ? payload.response : {};
        yield { kind: "messageStart", model: asString(envelope.model) ?? "" };
        break;
      }

      case "response.output_item.added": {
        const item = isRecord(payload.item) ? payload.item : {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const freeform = item.type === "custom_tool_call";
          const part = toolCallPart(item, freeform);
          if (part === null) { yield { kind: "unhandled", rawType: `response.output_item.added:${String(item.type)}`, raw: payload }; break; }
          sawToolCall = true;
          const index = indexer.allocate(`${outputIndex}:item`);
          indexer.toolBuffers.set(index, "");
          yield { kind: "partStart", index, part };
          const seed = freeform ? asString(item.input) : asString(item.arguments);
          if (seed !== null && seed.length > 0) {
            indexer.toolBuffers.set(index, seed);
            yield { kind: "partDelta", index, delta: freeform ? { kind: "toolInputText", text: seed } : { kind: "toolInputJson", json: seed } };
          }
          break;
        }
        // message / reasoning 的 part 由后续的 content_part.added / summary delta 惰性开出来，
        // 因为它们的真正内容此刻还不在报文里。
        if (item.type === "message" || item.type === "reasoning") break;
        yield { kind: "unhandled", rawType: `response.output_item.added:${String(item.type)}`, raw: payload };
        break;
      }

      case "response.content_part.added": {
        const part = isRecord(payload.part) ? payload.part : {};
        if (part.type !== "output_text" && part.type !== "refusal") {
          yield { kind: "unhandled", rawType: `response.content_part.added:${String(part.type)}`, raw: payload };
          break;
        }
        const index = indexer.allocate(`${outputIndex}:content:${numberOr(payload.content_index, 0)}`);
        yield { kind: "partStart", index, part: { kind: "text", text: asString(part.text) ?? "" } };
        break;
      }

      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = asString(payload.delta);
        if (delta === null) { yield { kind: "unhandled", rawType: type, raw: payload }; break; }
        const key = `${outputIndex}:content:${numberOr(payload.content_index, 0)}`;
        const fresh = !indexer.has(key);
        const index = indexer.allocate(key);
        // content_part.added 缺席时惰性开块：帧序不完美不该让正文消失。
        if (fresh) yield { kind: "partStart", index, part: { kind: "text", text: "" } };
        yield { kind: "partDelta", index, delta: { kind: "text", text: delta } };
        break;
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning.delta": {
        const delta = asString(payload.delta) ?? asString(payload.text);
        if (delta === null) { yield { kind: "unhandled", rawType: type, raw: payload }; break; }
        const slot = numberOr(payload.summary_index, numberOr(payload.content_index, 0));
        const key = `${outputIndex}:reasoning:${slot}`;
        const fresh = !indexer.has(key);
        const index = indexer.allocate(key);
        if (fresh) yield { kind: "partStart", index, part: { kind: "thinking", text: "" } };
        yield { kind: "partDelta", index, delta: { kind: "thinking", text: delta } };
        break;
      }

      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const freeform = type === "response.custom_tool_call_input.delta";
        const delta = asString(payload.delta);
        if (delta === null) { yield { kind: "unhandled", rawType: type, raw: payload }; break; }
        const key = `${outputIndex}:item`;
        const fresh = !indexer.has(key);
        const index = indexer.allocate(key);
        if (fresh) {
          // output_item.added 缺席（实测 codex 有过这种帧序）时仍要开块，否则整个工具调用蒸发。
          const id = asString(payload.item_id) ?? asString(payload.call_id) ?? `call_${index}`;
          sawToolCall = true;
          indexer.toolBuffers.set(index, "");
          yield {
            kind: "partStart", index,
            part: {
              kind: "toolCall",
              call: {
                id, toolRef: { group: null, name: asString(payload.name) ?? "" },
                input: freeform ? { kind: "text", text: "" } : { kind: "json", value: {} },
              },
            },
          };
        }
        indexer.toolBuffers.set(index, (indexer.toolBuffers.get(index) ?? "") + delta);
        yield { kind: "partDelta", index, delta: freeform ? { kind: "toolInputText", text: delta } : { kind: "toolInputJson", json: delta } };
        break;
      }

      case "response.function_call_arguments.done":
      case "response.custom_tool_call_input.done": {
        // 只有增量一条都没来过时才补发：上游两种发法都见过（全靠 delta / 只有 done 带全量）。
        const freeform = type === "response.custom_tool_call_input.done";
        const full = freeform ? asString(payload.input) : asString(payload.arguments);
        const index = indexer.get(`${outputIndex}:item`);
        if (index === undefined || full === null || full.length === 0) break;
        if ((indexer.toolBuffers.get(index) ?? "").length > 0) break;
        indexer.toolBuffers.set(index, full);
        yield { kind: "partDelta", index, delta: freeform ? { kind: "toolInputText", text: full } : { kind: "toolInputJson", json: full } };
        break;
      }

      case "response.output_item.done": {
        const item = isRecord(payload.item) ? payload.item : {};
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          const freeform = item.type === "custom_tool_call";
          const index = indexer.get(`${outputIndex}:item`);
          if (index !== undefined) {
            const full = freeform ? asString(item.input) : asString(item.arguments);
            if (full !== null && full.length > 0 && (indexer.toolBuffers.get(index) ?? "").length === 0) {
              indexer.toolBuffers.set(index, full);
              yield { kind: "partDelta", index, delta: freeform ? { kind: "toolInputText", text: full } : { kind: "toolInputJson", json: full } };
            }
            yield { kind: "partEnd", index };
          }
          break;
        }
        if (item.type === "reasoning") {
          for (const index of indexer.indicesFor(outputIndex)) yield { kind: "partEnd", index };
          // encrypted_content 只在 done 帧上出现，而它是 store=false 时回传思考的唯一凭据 ——
          // 不接住它，下一轮请求就没法让上游认出自己上一轮的推理。
          const encrypted = asString(item.encrypted_content);
          if (encrypted !== null && encrypted.length > 0) {
            const index = indexer.freshIndex();
            yield { kind: "partStart", index, part: { kind: "redactedThinking", data: encrypted } };
            yield { kind: "partEnd", index };
          }
          break;
        }
        if (item.type === "message") {
          for (const index of indexer.indicesFor(outputIndex)) yield { kind: "partEnd", index };
          break;
        }
        yield { kind: "unhandled", rawType: `response.output_item.done:${String(item.type)}`, raw: payload };
        break;
      }

      case "response.content_part.done": {
        const index = indexer.get(`${outputIndex}:content:${numberOr(payload.content_index, 0)}`);
        if (index !== undefined) yield { kind: "partEnd", index };
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        sawTerminal = true;
        const envelope = isRecord(payload.response) ? payload.response : {};
        const usage = usageFrom(envelope.usage);
        if (usage !== null) yield { kind: "usage", usage };
        yield { kind: "messageStop", reason: stopReasonFrom(envelope, sawToolCall) };
        break;
      }

      case "response.failed": {
        sawTerminal = true;
        const envelope = isRecord(payload.response) ? payload.response : {};
        const usage = usageFrom(envelope.usage);
        if (usage !== null) yield { kind: "usage", usage };
        yield { kind: "error", error: mapUpstreamError(envelope, null) };
        break;
      }

      case "error":
        // 上游会在流中途拒绝而不是用 HTTP 状态码，最常见的就是 context_length_exceeded。
        sawTerminal = true;
        yield { kind: "error", error: mapUpstreamError(payload, null) };
        break;

      // 确实不携带 IR 信息，丢掉是对的，但必须**显式**声明丢，否则和「上游加了新事件、
      // 我们没接住」混在同一个缺省分支里就分不出来了。这批来自真实流量统计：
      // response.created 432 / in_progress 365 / content_part.added 521 / done 521 /
      // output_text.done 521（正文已由 .delta 累计）/ keepalive 12（codex 自己的心跳，
      // 文档没写，但它真实存在，不该被当成协议漂移）。
      case "response.output_text.done":
      case "response.refusal.done":
      case "response.reasoning_summary_text.done":
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done":
      case "keepalive":
        break;

      default:
        // 不变量 4：没匹配上的事件是流里的元素，不是 switch 的黑洞。
        yield { kind: "unhandled", rawType: type.length === 0 ? "<empty>" : type, raw: payload };
    }
  }

  // 上游把流掐断却没发终止事件：必须显式终止。此前那版在这里直接收尾，产出的是
  // stop_reason 正常的空回合 —— 一个「看起来成功」的 200，调用方只能盲重试到 retry cap。
  if (!sawTerminal) {
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a terminal event (expected response.completed / response.incomplete / response.failed / error)",
        raw: null,
      },
    };
  }
}

async function* liftResponsesJson(response: Response): AsyncGenerator<IREvent> {
  const text = await response.text();
  const payload = tryParseJson<Record<string, unknown>>(text);
  if (payload === null || !isRecord(payload)) {
    yield { kind: "error", error: mapUpstreamError(text, response.status) };
    return;
  }
  // 非流式的失败有两种形状：顶层 error 信封，或 status:'failed' + response.error。
  if (isRecord(payload.error)) {
    yield { kind: "error", error: mapUpstreamError(payload, response.status) };
    return;
  }
  const envelope = isRecord(payload.response) ? payload.response : payload;
  if (asString(envelope.status) === "failed") {
    yield { kind: "error", error: mapUpstreamError(envelope, response.status) };
    return;
  }

  yield { kind: "messageStart", model: asString(envelope.model) ?? "" };
  const result = yield* synthesizeOutput(envelope.output, 0);
  const usage = usageFrom(envelope.usage);
  if (usage !== null) yield { kind: "usage", usage };
  yield { kind: "messageStop", reason: stopReasonFrom(envelope, result.sawToolCall) };
}
