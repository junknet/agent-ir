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
 * 那种位置重排，只需要核对「调用必须有对应输出」这一条上游硬约束。
 *
 * `writeOutboxRequest` 是**编译或拒绝**：能表达就出 wire，表达不了就带精确 IR 路径拒绝，
 * 绝不发一个非法 body 去换回语义模糊的 4xx。判据与逐条判定见 `OutboxRequestReport`。
 */
import { iterateSse, tryParseJson } from "../ir/sse.ts";
import type { OutboxResponseReadInterceptionOptions } from "../ir/ir_message_interception_extensions.ts";
import type {
  IRBuildProblem, IRCapability, IREffort, IROutbox, IROutboxProfile, IREvent, IRLoss, IRMandatoryFieldTable,
  OutboxRequestBuildResult, IRPart, IRReasoningDisplay,
  IRRequest, IRStopReason, IRTool, IROutboxError, IRUsage,
} from "../ir/types.ts";

const OUTBOX = "openai_responses";

/**
 * 逐项都核对过真实报文或真实端点行为，没核对上的一律不进这个集合。
 *
 * toolGroup / toolFreeform / toolBuiltin 三项是这个出口独有的原生能力（见文件头）。
 * `document` 不在这里：`input_file` 在 80 条归档请求与 94 份 rollout 里**一次都没出现过**，
 * 拿不准的形状写进 supports 等于拿整条请求赌一个 400；它也不在 lossy 里 —— 见下方说明。
 */
const SUPPORTED = [
  "stream", "nonStream", "systemPrompt", "multiTurn", "image",
  "thinking", "reasoningEffort",
  "toolFunction", "toolFreeform", "toolBuiltin", "toolGroup", "toolParallel", "toolChoiceSpecific", "toolResultImage",
  "structuredOutput", "maxOutputTokens", "temperature", "topP", "serviceTier",
] as const satisfies readonly IRCapability[];

/**
 * 能承载但有损。每一项都在 `lower` 里对应一处真实的降级动作 + 一条 IRLoss：
 *
 *   thinkingSignature  Anthropic 的签名思考块在 Responses 没有载体（这里的凭据是
 *                      `reasoning.encrypted_content`），签名只能丢
 *   reasoningBudget    Responses 没有 token 预算参数，只能折算成 effort 档
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
  "thinkingSignature", "reasoningBudget", "toolResultError",
  "cacheBreakpoint", "contextEdit", "stopSequences", "topK",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

// 两个集合都不放，因此准入层直接判这家上游不可用并给出精确 IR 路径：
//   document         `input_file` 的形状在 80 条归档请求与 94 份 rollout 里一次都没出现过。
//                    以前它在 lossy 里，靠一句文本占位符「承载」—— 那不是承载，是网关替
//                    客户端决定让模型看一句转述。占位是策略（`textualizeUnsupportedDocument`），
//                    所以这条能力的诚实结论是：这条路线载不动。

export interface OpenAIResponsesOutboxOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/**
 * 一次构造的全部产出：**有损留痕**与**拒绝理由**收在同一个对象里。
 *
 * 分界线（本文件每一处判定都由它推出）：
 *   - **编译事实**（`record`）：Responses 的 wire 真的没有这个位置，而 Core **不必写出
 *     任何客户端没说过的内容**。例如输出 item 没有错误位、没有 stop 参数、没有 top_k、
 *     没有显式缓存断点、effort 只有那几档。
 *   - **策略**（`reject`）：Core 得**发明内容、补默认值或拿文本占位符顶替**才能凑出一个
 *     合法 body。这类决定换一个调用方就想要不同结果，归 `src/repair`；Core 带路径拒绝。
 *
 * 拒绝**收集齐再返回**，不短路：调用方一次看全才能一次修完。
 */
class OutboxRequestReport {
  readonly #losses: IRLoss[] = [];
  readonly #problems: IRBuildProblem[] = [];
  record(loss: Omit<IRLoss, "stage" | "outbox">): void {
    this.#losses.push({ stage: "outbox", outbox: OUTBOX, ...loss });
  }
  reject(problem: IRBuildProblem): void {
    this.#problems.push(problem);
  }
  get rejected(): boolean { return this.#problems.length > 0; }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
  drainProblems(): readonly IRBuildProblem[] { return [...this.#problems]; }
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
  part: IRPart, role: "user" | "assistant" | "developer", path: string, report: OutboxRequestReport,
): WireItem | null {
  switch (part.kind) {
    case "text":
      if (part.text.length === 0) return null;
      return role === "assistant"
        ? { type: "output_text", text: part.text, annotations: [] }
        : { type: "input_text", text: part.text };
    case "image":
      if (role === "assistant") {
        report.record({ path, kind: "dropped", detail: "assistant message content accepts output_text only; image dropped" });
        return null;
      }
      // 实测 input_image.image_url 是**裸字符串**（可能是 data: URL），不是嵌套对象。
      return { type: "input_image", image_url: dataUrl(part) };
    case "document":
      // **策略**，已剥离：`input_file` 的形状在 80 条归档请求与 94 份 rollout 里一次都没
      // 出现过，这条路线**载不动文档**。以前换成一句「这里本来有个文档」的占位文本 ——
      // 那是网关替客户端决定「让模型看一句转述而不是正文」，模型据此作答会像读过一份
      // 它从没读过的文件。载不动就说载不动；要占位的调用方显式 compose
      // `textualizeUnsupportedDocument`。
      report.reject({
        kind: "unrepresentablePart",
        path,
        detail: `document (${part.media.mediaType}) has no verified carrier on /v1/responses: the input_file shape `
          + "appears in no archived request or rollout, and the gateway will not substitute a text description "
          + "(compose repair 'textualizeUnsupportedDocument' to accept that trade)",
      });
      return null;
    case "opaque":
      // 同源原样放回（无损往返）；异源没法翻译，丢弃留痕。
      if (part.origin === "openai_responses" && isRecord(part.raw)) return part.raw;
      report.record({
        path, kind: "dropped",
        detail: `opaque part from ${part.origin} (${part.tag}) has no Responses content representation`,
      });
      return null;
    case "thinking":
    case "redactedThinking":
    case "toolCall":
    case "toolResult":
      // 这四种在 Responses 里是**独立 item**，不是 message 的 content，由调用方分流。
      report.record({ path, kind: "dropped", detail: `'${part.kind}' is not a message content shape and was not routed to its own item` });
      return null;
  }
}

/** 工具结果 parts → 输出 item 的 `output`。文本与图片都以 input 内容块原样承载。 */
function lowerToolOutput(
  parts: readonly IRPart[], status: "ok" | "error" | "missing", path: string, report: OutboxRequestReport,
): Array<WireItem> {
  const blocks: WireItem[] = [];
  parts.forEach((part, index) => {
    const childPath = `${path}.result.parts[${index}]`;
    if (part.kind === "text") {
      if (part.text.length > 0) blocks.push({ type: "input_text", text: part.text });
      return;
    }
    if (part.kind === "image") {
      blocks.push({ type: "input_image", image_url: dataUrl(part) });
      return;
    }
    report.record({ path: childPath, kind: "dropped", detail: `'${part.kind}' has no representation inside a Responses tool output` });
  });
  if (status === "error") {
    // **编译事实**：输出 item 上没有 is_error 之类的错误位，正文是唯一的承载位置，而写
    // 进去的是 IR 里**已有的** status，不是发明出来的内容。不标记的话模型会当成执行成功
    // —— 那正是「假装工具返回空」那类最贵的静默失败。
    report.record({
      path, kind: "degraded",
      detail: "Responses tool output has no error flag; the failure is marked inside the output text instead",
    });
    blocks.unshift({ type: "input_text", text: "[gateway: this tool call failed]" });
  }
  if (blocks.length === 0) {
    // **策略**，已剥离：以前补一个空的 input_text。空串对模型的意思是「工具跑完了，
    // 没有输出」，而 IR 说的只是「没有内容」—— 把未知说成成功是最贵的那种谎。
    report.reject({
      kind: "requiredFieldMissing",
      path,
      detail: "tool output lowers to zero content blocks; Responses needs an output and the gateway will not "
        + "invent one (compose repair 'fillEmptyToolResult' to choose the wording)",
    });
  }
  return blocks;
}

function lowerToolCallItem(part: Extract<IRPart, { kind: "toolCall" }>, path: string, report: OutboxRequestReport): WireItem {
  const { call } = part;
  if (call.input.kind === "text") {
    // freeform 的原生形态。实测 custom_tool_call 的键集是 {type,id,status,call_id,name,input}，
    // **没有 namespace** —— 分组的 freeform 工具只能在调用侧丢掉分组。
    if (call.toolRef.group !== null) {
      report.record({
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
 * 推理 item。inbox 把一条 `reasoning` 拆成若干 thinking part + 一个 redactedThinking part，
 * 这里把连续的一段合回一个 item，`encrypted_content` 原样回传 —— 这是 store=false 时
 * 让上游认得自己上一轮思考的唯一凭据。
 *
 * **没有 encrypted_content 就不发**：rollout 里 10204 条 reasoning 无一例外都带它，
 * summary-only 的形状从未在真实报文里出现过，赌它能过等于赌整条请求。跨协议进来的
 * Anthropic 签名思考正好落在这一支，丢弃并留痕（codex_provider 的做法也是整段不译）。
 */
function lowerReasoningRun(run: readonly IRPart[], path: string, report: OutboxRequestReport): WireItem | null {
  const summary: WireItem[] = [];
  let encrypted: string | null = null;
  for (const part of run) {
    if (part.kind === "thinking") {
      if (part.signature !== undefined) {
        report.record({
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
    report.record({
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

function lowerConversation(request: IRRequest, report: OutboxRequestReport): LoweredConversation {
  const { conversation } = request;
  const items: WireItem[] = [];
  const callKinds = new Map<string, CallKind>();
  // 配对检查在 **IR 层**做，不在 wire item 上做：wire item 只剩 call_id，拒绝时报不出
  // 「是哪个 part」，而拒绝的全部价值就在这条路径上。
  const callSites = new Map<string, string>();
  const outputSites = new Map<string, string>();
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
    const block = lowerContentPart(part, "developer", path, report);
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
      const item = lowerReasoningRun(reasoningRun, path, report);
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
        callSites.set(part.call.id, path);
        items.push(lowerToolCallItem(part, path, report));
        continue;
      }
      if (part.kind === "toolResult") {
        flush();
        outputSites.set(part.result.callId, path);
        const kind = callKinds.get(part.result.callId) ?? "function";
        items.push({
          type: kind === "custom" ? "custom_tool_call_output" : "function_call_output",
          call_id: part.result.callId,
          output: lowerToolOutput(part.result.parts, part.result.status, path, report),
        });
        continue;
      }
      const block = lowerContentPart(part, turn.role, path, report);
      if (block !== null) pending.push(block);
    }
    flushReasoning(`$.conversation.turns[${turnIndex}]`);
    flush();
  }

  if (cacheBreakpoints > 0) {
    report.record({
      path: "$.conversation", kind: "dropped",
      detail: `${cacheBreakpoints} ephemeral cache breakpoint(s) dropped; Responses caches automatically (prompt_cache_key) and has no explicit breakpoint`,
    });
  }

  checkToolPairing(callSites, outputSites, report);
  return { instructions: instructionLines.join("\n\n"), items };
}

/**
 * 上游的唯一硬约束：**每个 function_call / custom_tool_call 都必须有配对的输出 item**
 * （缺了 400 "No tool output found for function call"，多了同样 400）。
 *
 * 这里**只裁决、不动手**。原先的补占位输出与丢孤儿都是策略，已剥离：
 *   - 悬空调用补 `[gateway: tool result missing…]` —— 网关编了一段模型会读到的正文；
 *   - 孤儿结果直接丢 —— 客户端真送来的工具输出就此蒸发。
 * 两条在 `IR_REPAIR_KINDS` 里各有对应项（`fillDanglingToolCall` / `dropOrphanToolResult`），
 * 由调用方显式 compose。
 *
 * 位置本身不需要处理：Responses 的 item 序列没有「结果必须紧邻且最前」那套排列规则，
 * IR 的顺序直接就是合法顺序 —— 这正是它相对 Anthropic / Chat 出口省下的一整套重排。
 */
function checkToolPairing(
  callSites: ReadonlyMap<string, string>,
  outputSites: ReadonlyMap<string, string>,
  report: OutboxRequestReport,
): void {
  for (const [callId, path] of callSites) {
    if (outputSites.has(callId)) continue;
    report.reject({
      kind: "danglingToolCall",
      path,
      detail: `tool call ${callId} has no tool output in the conversation; /v1/responses answers an unpaired call `
        + "with 400 \"No tool output found for function call\", and the gateway will not invent an output "
        + "(compose repair 'fillDanglingToolCall' to choose the placeholder wording)",
    });
  }
  for (const [callId, path] of outputSites) {
    if (callSites.has(callId)) continue;
    report.reject({
      kind: "orphanToolResult",
      path,
      detail: `tool result ${callId} has no matching tool call; /v1/responses rejects an output item whose call_id `
        + "it never issued, and dropping it would hide an output the client did send "
        + "(compose repair 'dropOrphanToolResult' to discard it deliberately)",
    });
  }
}

function lowerTools(request: IRRequest, report: OutboxRequestReport): WireItem[] {
  const { toolset } = request.conversation;

  const lowerOne = (tool: IRTool, index: number): WireItem => {
    const path = `$.conversation.toolset.tools[${index}]`;
    if (tool.kind === "function") {
      if (tool.deferLoading === true) {
        report.record({ path, kind: "dropped", detail: "defer_loading is an Anthropic-only hint with no Responses equivalent" });
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

function lowerReasoningConfig(request: IRRequest, report: OutboxRequestReport): Record<string, unknown> | null {
  const reasoning = request.intent.reasoning.value;
  if (reasoning.mode === "disabled") {
    report.record({
      path: "$.intent.reasoning", kind: "dropped",
      detail: "Responses has no verified switch to turn reasoning off on a reasoning model; the request is sent without a reasoning field and the upstream decides",
    });
    return null;
  }

  let effort = reasoning.effort;
  if (effort !== undefined && EFFORT_WIRE[effort] !== effort) {
    // **编译事实**：wire 的档位枚举没有 xhigh/max 这两级，夹进可表达区间是唯一的承载
    // 方式。客户端「尽量多想」的意图仍以最高可表达档位生效，少的只是分辨率，Core 没有
    // 引入任何客户端没说过的新维度 —— 同一根强度轴降分辨率，与 stop_sequences 截断同类。
    // 反过来拒绝才是替调用方做了**更大**的决定：为了保住一档分辨率，让整个上游不可用。
    // 判断与夹后值都只从 `EFFORT_WIRE` 读，detail 必须同时带上**原值与夹后值** ——
    // 只说结果的留痕，事后没人能从日志里还原客户端到底要的是哪一档。
    report.record({
      path: "$.intent.reasoning.effort", kind: "substituted",
      detail: `effort '${effort}' is not an accepted Responses value; clamped to '${EFFORT_WIRE[effort]}'`,
    });
  }
  if (reasoning.budgetTokens !== undefined) {
    if (effort === undefined) {
      // **编译事实**：Responses 只有档位这一根推理强度轴，token 预算在 wire 上没有位置。
      // 换算是同一根轴上的降分辨率（`reasoningBudget` 因此在 LOSSY 里声明过），
      // 不是替客户端引入一个新的意图。
      effort = effortFromBudget(reasoning.budgetTokens);
      report.record({
        path: "$.intent.reasoning.budgetTokens", kind: "substituted",
        detail: `Responses has no reasoning token budget; budget_tokens=${reasoning.budgetTokens} converted to effort '${effort}'`,
      });
    } else {
      report.record({
        path: "$.intent.reasoning.budgetTokens", kind: "dropped",
        detail: `Responses has no reasoning token budget; budget_tokens=${reasoning.budgetTokens} dropped in favour of the explicit effort '${effort}'`,
      });
    }
  }
  if (reasoning.display === "full") {
    report.record({
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

/**
 * `/v1/responses` **不要求** max_output_tokens —— 恰恰相反：私有 codex 端点对它直接 400
 * （见文件头），所以这里连「可以发」都是有条件的，更谈不上必填。
 */
const MANDATORY: IRMandatoryFieldTable = { maxOutputTokens: false };

/**
 * 无已知危害。判据是**没有一条真实拒绝**是内容策略造成的：这家从未因系统提示词的
 * 内容本身拒过请求（拒绝都来自 wire 层的字段问题，那是 `writeOutboxRequest` 的事）。
 *
 * `false` 是一次表态，不是缺省 —— 新增一种危害时编译器会回到这里逼人重新回答。
 */

export function createOpenAIResponsesOutbox(options: OpenAIResponsesOutboxOptions): IROutbox {
  const profile: IROutboxProfile = {
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
    mandatory: MANDATORY,
  };

  return {
    profile,

    async writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult> {
      const report = new OutboxRequestReport();
      const { conversation, intent } = request;
      const { instructions, items } = lowerConversation(request, report);
      const tools = lowerTools(request, report);
      const reasoning = lowerReasoningConfig(request, report);

      if (intent.stopping.stopSequences !== undefined) {
        report.record({
          path: "$.intent.stopping.stopSequences", kind: "dropped",
          detail: "/v1/responses has no stop parameter (only Chat Completions does); stop sequences are not enforced upstream",
        });
      }
      if (intent.sampling.topK !== undefined) {
        report.record({
          path: "$.intent.sampling.topK", kind: "dropped",
          detail: "Responses exposes temperature and top_p only; top_k has no equivalent",
        });
      }
      if (intent.contextEdits.length > 0) {
        report.record({
          path: "$.intent.contextEdits", kind: "dropped",
          detail: `${intent.contextEdits.length} context edit instruction(s) dropped; Responses has no history-editing directive (truncation:'auto' is not equivalent)`,
        });
      }

      const outputFormat = intent.outputFormat.value;
      let text: Record<string, unknown> | undefined;
      if (outputFormat.kind === "jsonSchema") {
        if (outputFormat.name === undefined) {
          // **策略**，已剥离：name 是上游必填字段，客户端没给。以前补 'response' —— 那个
          // 名字会随结构化输出回到客户端手里，替它取名等于替它定了一个对外可见的标识。
          report.reject({
            kind: "requiredFieldMissing",
            path: "$.intent.outputFormat",
            detail: "Responses requires a name on text.format.json_schema and the client stated none; "
              + "the gateway will not name the client's schema for it",
          });
        }
        text = outputFormat.name === undefined ? undefined : {
          format: {
            type: "json_schema",
            name: outputFormat.name,
            schema: outputFormat.schema,
            ...(outputFormat.strict === true ? { strict: true } : {}),
          },
        };
      }

      // 会话身份**部分**承载：`prompt_cache_key` 实测就是会话 uuid，sessionId 无损送达；
      // device_id / account_uuid 在这条 wire 上没有位置 —— `user` 的语义是滥用检测标识，
      // 把设备/账号 id 塞进去会改变上游对该字段的用法。丢的那两项各记一条，不静默。
      if (intent.identity.deviceId !== undefined || intent.identity.accountUuid !== undefined) {
        report.record({
          path: "$.intent.identity", kind: "dropped",
          detail: "/v1/responses carries the session id as prompt_cache_key but has no slot for the client's "
            + "device id or account uuid; its only identity field (`user`) means something else upstream",
        });
      }

      // 拒绝时**不构造 body**：半个非法请求体连序列化出来的机会都不该有。
      if (report.rejected) {
        return { ok: false, problems: report.drainProblems(), losses: report.drain() };
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
        // 实测 prompt_cache_key == 会话 uuid，是这个端点唯一的身份/缓存抓手。
        // device_id / account_uuid 没有对应位（`user` 的语义是滥用检测标识，不是会话身份），
        // 它们的丢弃在上面记了一条 loss。
        ...(intent.identity.sessionId === undefined ? {} : { prompt_cache_key: intent.identity.sessionId }),
      };

      return {
        ok: true,
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
        losses: report.drain(),
      };
    },

    readOutboxResponse(response: Response, readOptions?: OutboxResponseReadInterceptionOptions): AsyncIterable<IREvent> {
      return liftResponsesStream(response, readOptions);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// lift
// ═══════════════════════════════════════════════════════════════════════════

function mapOutboxError(payload: unknown, httpStatus: number | null): IROutboxError {
  const holder = isRecord(payload) ? payload : {};
  const inner = isRecord(holder.error) ? holder.error : holder;
  const code = asString(inner.code) ?? "";
  const type = asString(inner.type) ?? "";
  const message = asString(inner.message) ?? (typeof payload === "string" && payload.length > 0 ? payload : "upstream error");
  const tag = `${code} ${type}`.toLowerCase();

  const kind: IROutboxError["kind"] =
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
      ? "outboxUnavailable"
    : tag.includes("invalid_request") || tag.includes("invalid_prompt") || tag.includes("not_found")
      || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500)
      ? "invalidRequest"
    : "unknown";

  return {
    kind, httpStatus, message,
    retryable: kind === "rateLimited" || kind === "outboxUnavailable",
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

async function* liftResponsesStream(
  response: Response, readOptions?: OutboxResponseReadInterceptionOptions,
): AsyncGenerator<IREvent> {
  // 非 2xx：整体读出来当一次性错误，不进 SSE 解析。
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapOutboxError(tryParseJson(text) ?? text, response.status) };
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

  for await (const frame of iterateSse(response, readOptions?.inspectCompleteSseFrame)) {
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
        yield { kind: "error", error: mapOutboxError(envelope, null) };
        break;
      }

      case "error":
        // 上游会在流中途拒绝而不是用 HTTP 状态码，最常见的就是 context_length_exceeded。
        sawTerminal = true;
        yield { kind: "error", error: mapOutboxError(payload, null) };
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

  // 上游把流掐断却没发终止事件：必须显式终止。直接收尾产出的会是
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
    yield { kind: "error", error: mapOutboxError(text, response.status) };
    return;
  }
  // 非流式的失败有两种形状：顶层 error 信封，或 status:'failed' + response.error。
  if (isRecord(payload.error)) {
    yield { kind: "error", error: mapOutboxError(payload, response.status) };
    return;
  }
  const envelope = isRecord(payload.response) ? payload.response : payload;
  if (asString(envelope.status) === "failed") {
    yield { kind: "error", error: mapOutboxError(envelope, response.status) };
    return;
  }

  yield { kind: "messageStart", model: asString(envelope.model) ?? "" };
  const result = yield* synthesizeOutput(envelope.output, 0);
  const usage = usageFrom(envelope.usage);
  if (usage !== null) yield { kind: "usage", usage };
  yield { kind: "messageStop", reason: stopReasonFrom(envelope, result.sawToolCall) };
}
