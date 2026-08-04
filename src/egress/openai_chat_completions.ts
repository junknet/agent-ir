/**
 * OpenAI Chat Completions 出口：IR → wire（lower）+ 上游响应 → IREvent（lift）。
 *
 * 与 Anthropic 出口同构，但两处结构差异决定了这份实现的形状：
 *
 *   1. **工具结果是独立消息**（`role:'tool'` + `tool_call_id`），不是 user 消息里的一个块。
 *      语料里 tool 是 chat 协议出现最多的角色（2355 次）。位置约束仍在：tool 消息必须
 *      紧跟在声明该 id 的 assistant 消息之后，所以这里同样要靠 callId 重铺一次
 *      —— IR 内部按 id 关联，位置约束只在出口恢复一次。
 *   2. **响应没有事件类型**。Anthropic 的 SSE 每帧自带 `type`，Chat 的每帧长得一样，
 *      判别位藏在形状里（choices / usage / error）。因此 lift 先把 chunk 归形状，
 *      再对形状做 switch，缺省分支照样产出 unhandled —— 归不了形状的 chunk 就是上游漂移。
 *
 * `writeUpstreamRequest` 是**编译或拒绝**：能表达就出 wire，表达不了就带精确 IR 路径拒绝，
 * 绝不发一个非法 body 去换回语义模糊的 4xx。判据与逐条判定见 `UpstreamRequestReport`。
 *
 * 真实报文出处：`gateway-traffic-logs/*.ndjson` 里 108115 条
 * `chat.completion.chunk`（deepseek-v4-flash / kimi-k3 / glm-5 等兼容端点）。两个反直觉的
 * 实测点已在下面对应位置注明：`delta.content` 常态是 **null** 而不是缺省；工具调用的
 * 续帧带的是 `id:""` / `function.name:""` 而不是省略这两个键。
 */
import { iterateSse, tryParseJson } from "../ir/sse.ts";
import type {
  IRBuildProblem, IRCapability, IREffort, IREgress, IREgressProfile, IREvent, IRLoss,
  UpstreamRequestBuildResult, IRPart,
  IRRequest, IRStopReason, IRToolResult, IRTurn, IRUpstreamError, IRUsage,
} from "../ir/types.ts";

const PROVIDER = "openai_chat";

/**
 * 能承载且不失真的。
 *
 * `image` 在这里是 user 消息里的 `image_url`（base64 走 data: URI，url 直传）——
 * 注意它**不**蕴含 `toolResultImage`：tool 消息只吃文本，那是另一个能力位。
 */
const SUPPORTED = [
  "stream", "nonStream", "systemPrompt", "multiTurn", "image",
  "reasoningEffort",
  "toolFunction", "toolParallel", "toolChoiceSpecific",
  "structuredOutput",
  "maxOutputTokens", "stopSequences", "temperature", "topP", "serviceTier",
] as const satisfies readonly IRCapability[];

/**
 * 能承载但有损。判据只有一条：**上游忽略它之后，模型看到的内容与能做的事不变**，
 * 少掉的是供应商私有的元数据、成本/延迟优化位或强度表达的分辨率。
 *
 *   thinking / thinkingSignature  历史里的思考块整块丢弃。signature 是 Anthropic 的完整性
 *                                 凭据，对 chat 上游没有任何意义；带着它的回合去掉思考块后
 *                                 文本与工具调用一字不少。（语料 611 条 anthropic 请求里
 *                                 464 条带 signature —— 归成「不支持」等于把 76% 的真实流量
 *                                 永久挡在所有 chat 兼容上游之外，而客户端删不掉这个字段。）
 *   reasoningBudget               没有 budget_tokens，只能按档位折算成 reasoning_effort。
 *   toolFreeform                  没有自由文本入参工具，只能省掉 parameters（与本仓库
 *                                 chat 入口把「无 parameters」解成 freeform 恰好互逆）。
 *   toolGroup                     没有 namespace，只能把分组拍进工具名。
 *   toolResultError               tool 消息没有 is_error，错误状态只能写进文本里。
 *   cacheBreakpoint               没有 cache_control（types.ts 已就此表态：不支持缓存的
 *                                 egress 直接忽略并记 degraded loss）。
 *   contextEdit                   没有 context_management。指令丢了只影响上游的上下文预算，
 *                                 不改变本次发出去的内容。
 *   topK                          Chat 没有 top_k，只是一个采样旋钮，不值得让整个上游失格。
 *
 * 元素类型是 `Exclude<IRCapability, 已 supports 的>`：与 supports 重叠会被编译期挡下 ——
 * 重叠时准入先命中 supports 直接放行，上面逐条写下的降级动作与 IRLoss 就一条都不会发生。
 */
const LOSSY = [
  "thinking", "thinkingSignature", "reasoningBudget",
  "toolFreeform", "toolGroup", "toolResultError",
  "cacheBreakpoint", "contextEdit", "topK",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

// 两个集合都不放，因此准入层直接判这家上游不可用并给出精确 IR 路径：
//   document          Chat 的 `file` part 是 OpenAI 私有且只吃 PDF，兼容端点普遍拒收；
//                     本仓库 chat 入口自己也只把它装箱成 opaque。降级成占位文本等于
//                     模型根本看不到这份文档 —— 该换一家上游，不该假装送到了。
//   toolBuiltin       内建工具在上游执行。丢掉它模型就少了一整个能力，答案会是错的。
//   toolResultImage   tool 消息只能是文本。把图片提到后续 user 消息里会改变「谁说的话」
//                     并破坏 id 关联，写成占位文本则像素全丢 —— 两种都不是承载。

export interface ChatCompletionsUpstreamOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

// ── lower ──────────────────────────────────────────────────────────────────

/**
 * 一次构造的全部产出：**有损留痕**与**拒绝理由**收在同一个对象里。
 *
 * 分界线只有一条，本文件每一处判定都由它推出：
 *   - **编译事实**（`record`）：Chat 的 wire 真的没有这个位置，而 Core **不必替客户端
 *     写出任何值** —— 少掉的是供应商私有字段、结构位或强度分辨率。例如 tool 消息只吃文本、
 *     没有 is_error、没有 cache_control、effort 只有四档。
 *   - **策略**（`reject`）：Core 得**发明内容、补默认值或拿占位符顶替**才能凑出一个合法
 *     body。这类决定换一个调用方就想要不同结果，所以它属于 `src/repair`，不属于编译；
 *     Core 带着精确 IR 路径拒绝。
 *
 * 拒绝是**收集齐再返回**，不是遇到第一个就短路：调用方一次看全才能一次修完。
 */
class UpstreamRequestReport {
  readonly #losses: IRLoss[] = [];
  readonly #problems: IRBuildProblem[] = [];
  record(loss: Omit<IRLoss, "stage" | "provider">): void {
    this.#losses.push({ stage: "egress", provider: PROVIDER, ...loss });
  }
  reject(problem: IRBuildProblem): void {
    this.#problems.push(problem);
  }
  get rejected(): boolean { return this.#problems.length > 0; }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
  drainProblems(): readonly IRBuildProblem[] { return [...this.#problems]; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 分组名拍进工具名。有损（分组结构没了），调用方靠 loss 知道。 */
function flatToolName(group: string | null, name: string): string {
  return group === null ? name : `${group}__${name}`;
}

/** 缓存断点在 Chat 上无处安放。每个带断点的 part 各记一条，路径指到具体位置。 */
function noteCacheBreakpoint(part: IRPart, path: string, report: UpstreamRequestReport): void {
  if (part.cacheBreakpoint === undefined) return;
  report.record({
    path: `${path}.cacheBreakpoint`, kind: "dropped",
    detail: "Chat Completions has no cache_control; prefix caching is implicit and cannot be steered",
  });
}

function imageUrl(part: Extract<IRPart, { kind: "image" }>): string {
  return part.media.source.kind === "url"
    ? part.media.source.url
    : `data:${part.media.mediaType};base64,${part.media.source.data}`;
}

/** system 只能是文本。多个 part 之间用换行拼接，非文本 part 各记一条 loss。 */
function lowerSystem(parts: readonly IRPart[], report: UpstreamRequestReport): string {
  const chunks: string[] = [];
  parts.forEach((part, index) => {
    const path = `$.conversation.system[${index}]`;
    noteCacheBreakpoint(part, path, report);
    if (part.kind === "text") { chunks.push(part.text); return; }
    report.record({
      path, kind: "dropped",
      detail: `system message content must be text on Chat Completions; '${part.kind}' part has no representation`,
    });
  });
  return chunks.filter((text) => text.length > 0).join("\n");
}

type ChatContent = string | Array<Record<string, unknown>>;

/**
 * user 回合的内容。只要出现非文本元素就切成数组形态，否则保持字符串
 * —— 兼容端点对字符串 content 的支持面最广，能不用数组就不用。
 */
function lowerUserContent(parts: readonly IRPart[], turnPath: string, report: UpstreamRequestReport): ChatContent {
  const blocks: Array<Record<string, unknown>> = [];
  let structured = false;
  parts.forEach((part, index) => {
    const path = `${turnPath}.parts[${index}]`;
    noteCacheBreakpoint(part, path, report);
    switch (part.kind) {
      case "text":
        if (part.text.length > 0) blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        structured = true;
        blocks.push({ type: "image_url", image_url: { url: imageUrl(part) } });
        break;
      case "document":
        report.record({
          path, kind: "dropped",
          detail: "Chat Completions has no portable document part; compatible endpoints reject the OpenAI-only `file` block",
        });
        break;
      case "thinking":
      case "redactedThinking":
        report.record({
          path, kind: "dropped",
          detail: "Chat Completions has no place for thinking content inside a user message",
        });
        break;
      case "toolCall":
        report.record({
          path, kind: "dropped",
          detail: "a tool call cannot be carried by a user message; Chat puts tool_calls on the assistant message",
        });
        break;
      case "toolResult":
        // 正常路径下工具结果已被 arrangeMessages 摘走并铺成 role:'tool' 消息。
        report.record({
          path, kind: "dropped",
          detail: `tool result ${part.result.callId} could not be placed after its call`,
        });
        break;
      case "opaque":
        // 同源装箱原样放回（无损往返），异源的没法翻译。
        if (part.origin === "openai_chat_completions" && isRecord(part.raw)) {
          structured = true;
          blocks.push(part.raw);
          break;
        }
        report.record({
          path, kind: "dropped",
          detail: `opaque part from ${part.origin} (${part.tag}) has no Chat Completions representation`,
        });
        break;
    }
  });
  if (!structured) return blocks.map((block) => String(block.text ?? "")).join("");
  return blocks;
}

interface AssistantMessage {
  readonly content: string;
  readonly toolCalls: Array<Record<string, unknown>>;
  /** 调用 id 连同它的 IR 路径：悬空时拒绝要指到**声明它的那个 part**，不是笼统的回合。 */
  readonly calls: Array<{ readonly id: string; readonly path: string }>;
}

function lowerAssistant(parts: readonly IRPart[], turnPath: string, report: UpstreamRequestReport): AssistantMessage {
  const texts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const calls: Array<{ id: string; path: string }> = [];
  parts.forEach((part, index) => {
    const path = `${turnPath}.parts[${index}]`;
    noteCacheBreakpoint(part, path, report);
    switch (part.kind) {
      case "text":
        if (part.text.length > 0) texts.push(part.text);
        break;
      case "thinking":
        // 思考块整块丢。上游没有回传形态：兼容端点的 reasoning_content 是**只出不进**的
        // 响应字段，把它塞回请求里轻则被忽略重则 400。
        report.record({
          path, kind: "dropped",
          detail: part.signature === undefined
            ? "Chat Completions cannot carry assistant thinking back upstream; reasoning_content is response-only"
            : "Chat Completions cannot carry assistant thinking back upstream, and its signature has no field at all",
        });
        break;
      case "redactedThinking":
        report.record({
          path, kind: "dropped",
          detail: "Chat Completions has no redacted thinking block",
        });
        break;
      case "toolCall": {
        const name = flatToolName(part.call.toolRef.group, part.call.toolRef.name);
        if (part.call.toolRef.group !== null) {
          report.record({
            path, kind: "degraded",
            detail: `tool group '${part.call.toolRef.group}' flattened into the tool name; Chat Completions has no namespace concept`,
          });
        }
        if (part.call.caller !== undefined) {
          report.record({
            path, kind: "dropped",
            detail: "Chat Completions has no caller field on a tool call",
          });
        }
        calls.push({ id: part.call.id, path });
        toolCalls.push({
          id: part.call.id,
          type: "function",
          function: {
            name,
            // arguments 恒是 **JSON 字符串**，不是对象。freeform 入参原样当字符串送。
            arguments: part.call.input.kind === "json"
              ? JSON.stringify(part.call.input.value)
              : part.call.input.text,
          },
        });
        break;
      }
      case "image":
      case "document":
        report.record({
          path, kind: "dropped",
          detail: `Chat Completions assistant messages carry text and tool_calls only; '${part.kind}' part dropped`,
        });
        break;
      case "toolResult":
        report.record({
          path, kind: "dropped",
          detail: `tool result ${part.result.callId} cannot sit on an assistant message`,
        });
        break;
      case "opaque":
        report.record({
          path, kind: "dropped",
          detail: `opaque part from ${part.origin} (${part.tag}) has no assistant-side Chat Completions representation`,
        });
        break;
    }
  });
  return { content: texts.join(""), toolCalls, calls };
}

/**
 * tool 消息只吃文本：图片没了，错误状态只能写进正文。
 *
 * 两处判定：
 *   - 非文本 part 丢弃 / is_error 折进正文 —— **编译事实**。Chat 的 tool 消息就是一个
 *     字符串，没有第二个位置可放，而 Core 没有替客户端写出任何内容：`[tool error]` 记的是
 *     IR 里**已有的** status。
 *   - 正文为空 —— **策略**，已剥离。原先补 `(empty)` 是网关替客户端说「工具跑成功了且没有
 *     输出」，而 IR 说的只是「没有内容」，两者不是一回事：agent 会据此认为命令成功。
 *     想要占位的调用方显式 compose `src/repair` 的 `fillEmptyToolResult`。
 */
function lowerToolResultContent(result: IRToolResult, path: string, report: UpstreamRequestReport): string {
  const texts: string[] = [];
  result.parts.forEach((part, index) => {
    const partPath = `${path}.result.parts[${index}]`;
    noteCacheBreakpoint(part, partPath, report);
    if (part.kind === "text") { texts.push(part.text); return; }
    if (part.kind === "image") {
      report.record({
        path: partPath, kind: "dropped",
        detail: "a Chat Completions tool message cannot carry an image; the model never sees these pixels",
      });
      return;
    }
    report.record({
      path: partPath, kind: "dropped",
      detail: `tool result part '${part.kind}' has no Chat Completions representation`,
    });
  });
  let content = texts.join("");
  if (result.status === "error") {
    // is_error 是结构位，Chat 没有。写进正文是唯一的承载方式 —— 模型仍然知道失败了。
    report.record({
      path, kind: "degraded",
      detail: "Chat Completions tool messages have no is_error flag; the failure is folded into the text",
    });
    content = content.length === 0 ? "[tool error]" : `[tool error] ${content}`;
  }
  if (content.length === 0) {
    // 空 content 在部分兼容端点上会 400（实测 agent-all-sdk-ts openai_compat_provider）。
    // 补什么是决定，不是编译 —— 拒绝，并把位置指到这条工具结果上。
    report.reject({
      kind: "requiredFieldMissing",
      path,
      detail: `tool result ${result.callId} lowers to an empty Chat Completions tool message; `
        + "the endpoint requires content and the gateway will not invent a body for it "
        + "(compose repair 'fillEmptyToolResult' to choose the wording)",
    });
  }
  return content;
}

/**
 * 恢复 Chat 的工具消息位置不变量：
 *   assistant.tool_calls 里的每个 id 都要有一条紧随其后的 role:'tool' 消息。
 *
 * **重排是编译**：IR 按 id 关联、Chat 按位置关联，这是纯粹的表示转换，没有任何决定，
 * 所以它只在出口做一次（与 Anthropic 出口同一套做法：先全摘下来再按调用顺序重铺）。
 *
 * **补洞与去孤儿是策略**，已剥离成拒绝：
 *   - 悬空调用：以前补一条「结果未知」的占位 tool 消息 —— 那是网关替客户端编造了一段
 *     模型会读到的正文，措辞怎么写会直接改变 agent 的下一步；
 *   - 孤儿结果：以前直接丢 —— 客户端明确送来的工具输出就此蒸发，模型不会知道它存在过。
 * 两者都会让上游 400，所以两者都不能装作没发生，只能拒绝并指到具体位置。
 */
function arrangeMessages(
  turns: readonly IRTurn[],
  report: UpstreamRequestReport,
): Array<Record<string, unknown>> {
  const resultsByCallId = new Map<string, { part: Extract<IRPart, { kind: "toolResult" }>; path: string }>();
  const stripped = turns.map((turn, turnIndex) => ({
    role: turn.role,
    parts: turn.parts.filter((part, partIndex) => {
      if (part.kind !== "toolResult") return true;
      resultsByCallId.set(part.result.callId, { part, path: `$.conversation.turns[${turnIndex}].parts[${partIndex}]` });
      return false;
    }),
  }));

  const messages: Array<Record<string, unknown>> = [];
  const consumed = new Set<string>();

  stripped.forEach((turn, turnIndex) => {
    const turnPath = `$.conversation.turns[${turnIndex}]`;
    if (turn.role === "assistant") {
      const assistant = lowerAssistant(turn.parts, turnPath, report);
      if (assistant.content.length > 0 || assistant.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: assistant.content.length === 0 ? null : assistant.content,
          ...(assistant.toolCalls.length === 0 ? {} : { tool_calls: assistant.toolCalls }),
        });
      }
      for (const call of assistant.calls) {
        const found = resultsByCallId.get(call.id);
        if (found === undefined) {
          report.reject({
            kind: "danglingToolCall",
            path: call.path,
            detail: `tool call ${call.id} has no tool result in the conversation; Chat Completions rejects an `
              + "assistant tool_call without a following tool message, and the gateway will not invent one "
              + "(compose repair 'fillDanglingToolCall' to choose the placeholder wording)",
          });
          continue;
        }
        consumed.add(call.id);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: lowerToolResultContent(found.part.result, found.path, report),
        });
      }
      return;
    }

    const content = lowerUserContent(turn.parts, turnPath, report);
    const empty = typeof content === "string" ? content.length === 0 : content.length === 0;
    if (!empty) messages.push({ role: "user", content });
  });

  for (const [callId, found] of resultsByCallId) {
    if (consumed.has(callId)) continue;
    report.reject({
      kind: "orphanToolResult",
      path: found.path,
      detail: `tool result ${callId} has no matching tool call; a Chat Completions tool message with an unknown `
        + "tool_call_id is rejected upstream, and dropping it would hide an output the client did send "
        + "(compose repair 'dropOrphanToolResult' to discard it deliberately)",
    });
  }

  return messages;
}

/** OpenAI 只认这四档。xhigh / max 是 IR 侧更高的档位，只能夹到 high。 */
const EFFORT_WIRE: Record<IREffort, string> = {
  minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high",
};

/** budget → 档位。阈值沿用 agent-all-sdk-ts 的 toCodexEffort，不另发明一套。 */
function effortFromBudget(budgetTokens: number): string {
  return budgetTokens <= 1024 ? "low" : budgetTokens <= 4096 ? "medium" : "high";
}

export function createChatCompletionsUpstream(options: ChatCompletionsUpstreamOptions): IREgress {
  const profile: IREgressProfile = {
    provider: PROVIDER,
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
  };

  return {
    profile,

    async writeUpstreamRequest(request: IRRequest): Promise<UpstreamRequestBuildResult> {
      const report = new UpstreamRequestReport();
      const { conversation, intent } = request;

      const messages: Array<Record<string, unknown>> = [];
      const system = lowerSystem(conversation.system, report);
      if (system.length > 0) messages.push({ role: "system", content: system });
      messages.push(...arrangeMessages(conversation.turns, report));

      const tools = conversation.toolset.tools.flatMap((tool, index) => {
        const path = `$.conversation.toolset.tools[${index}]`;
        const name = flatToolName(tool.ref.group, tool.ref.name);
        if (tool.ref.group !== null) {
          report.record({
            path, kind: "degraded",
            detail: `tool group '${tool.ref.group}' flattened into the tool name; Chat Completions has no namespace concept`,
          });
        }
        if (tool.kind === "function") {
          return [{
            type: "function",
            function: {
              name, description: tool.description, parameters: tool.schema,
              ...(tool.strict === true ? { strict: true } : {}),
            },
          }];
        }
        if (tool.kind === "freeform") {
          // Chat 的工具入参恒是 JSON schema 下的对象。省掉 parameters 是最接近的形态
          // （本仓库 chat 入口正是把「无 parameters」解回 freeform），但模型拿不到
          // 「随便写文本」这个语义。
          report.record({
            path, kind: "degraded",
            detail: `freeform tool '${name}' lowered without a parameters schema; Chat Completions has no freeform argument form`,
          });
          return [{ type: "function", function: { name, description: tool.description } }];
        }
        report.record({
          path, kind: "dropped",
          detail: `builtin tool '${tool.builtin}' is executed upstream and has no Chat Completions equivalent`,
        });
        return [];
      });

      const choice = conversation.toolset.choice.value;
      const toolChoice =
        choice.kind === "auto" ? "auto"
        : choice.kind === "none" ? "none"
        : choice.kind === "required" ? "required"
        : { type: "function", function: { name: flatToolName(choice.ref.group, choice.ref.name) } };

      const reasoning = intent.reasoning.value;
      let reasoningEffort: string | undefined;
      if (reasoning.effort !== undefined) {
        const clampedEffort = EFFORT_WIRE[reasoning.effort];
        reasoningEffort = clampedEffort;
        // 「有没有被夹」由 `EFFORT_WIRE` 自己回答（值变了就是夹了），不另写一份
        // `effort === 'xhigh' || effort === 'max'` 的档位清单：那是同一个概念的第二份手抄，
        // 新增一档时表里会被逼着表态，而手抄的判断会安静地不再命中 —— 夹档照旧发生，loss
        // 却消失了，正是「有损无痕」。夹后值同样取自表，detail 里不出现硬编码的 'high'。
        if (clampedEffort !== reasoning.effort) {
          // **编译事实**：wire 的档位枚举只有四级，IR 的第五、六级没有位置，夹进可表达
          // 区间是唯一的承载方式。Core 没有引入客户端没说过的新维度 ——「尽量多想」这个
          // 意图仍以最高的可表达档位生效，少掉的只是分辨率（同 stop_sequences 截断）。
          // 反过来拒绝才是替调用方做了**更大**的决定：为了保住一档分辨率，让整个上游不可用。
          report.record({
            path: "$.intent.reasoning.effort", kind: "substituted",
            detail: `Chat Completions accepts minimal|low|medium|high; effort '${reasoning.effort}' clamped to '${clampedEffort}'`,
          });
        }
        if (reasoning.budgetTokens !== undefined) {
          report.record({
            path: "$.intent.reasoning.budgetTokens", kind: "dropped",
            detail: "Chat Completions has no thinking budget; the client's explicit effort took precedence",
          });
        }
      } else if (reasoning.budgetTokens !== undefined) {
        reasoningEffort = effortFromBudget(reasoning.budgetTokens);
        report.record({
          path: "$.intent.reasoning.budgetTokens", kind: "degraded",
          detail: `Chat Completions has no budget_tokens; ${reasoning.budgetTokens} tokens bucketed into reasoning_effort '${reasoningEffort}'`,
        });
      }
      if (reasoning.mode === "disabled" && intent.reasoning.source === "client") {
        report.record({
          path: "$.intent.reasoning.mode", kind: "dropped",
          detail: "the client asked for thinking to be disabled; Chat Completions has no switch to turn a reasoning model off",
        });
      }
      // `reasoning.display` 在这里**不记 loss**：Chat 的请求侧根本没有这个维度，而响应侧
      // 兼容端点回的 reasoning_content 就是全文；思考给不给客户端看是入口 encoder 的决定，
      // 它手上仍然有 intent.reasoning.display。出口在这里报一条只会变成每条请求都有的噪音。

      const outputFormat = intent.outputFormat.value;
      let responseFormat: Record<string, unknown> | undefined;
      if (outputFormat.kind === "jsonSchema") {
        if (outputFormat.name === undefined) {
          // **策略**，已剥离：json_schema.name 是上游必填且受字符集限制的字段，客户端没给。
          // 以前补 'response' —— 那个名字会随结构化输出一起回到客户端手里，网关替它取名
          // 等于替它定了一个对外可见的标识。名字只有客户端知道该叫什么。
          report.reject({
            kind: "requiredFieldMissing",
            path: "$.intent.outputFormat",
            detail: "Chat Completions requires response_format.json_schema.name and the client stated none; "
              + "the gateway will not name the client's schema for it",
          });
        }
        responseFormat = outputFormat.name === undefined ? undefined : {
          type: "json_schema",
          json_schema: {
            name: outputFormat.name,
            schema: outputFormat.schema,
            ...(outputFormat.strict === true ? { strict: true } : {}),
          },
        };
      }

      let stop: string[] | undefined;
      if (intent.stopping.stopSequences !== undefined) {
        stop = [...intent.stopping.stopSequences.value];
        if (stop.length > 4) {
          report.record({
            path: "$.intent.stopping.stopSequences", kind: "truncated",
            detail: `Chat Completions accepts at most 4 stop sequences; ${stop.length} supplied, kept the first 4`,
          });
          stop = stop.slice(0, 4);
        }
      }

      if (intent.sampling.topK !== undefined) {
        report.record({
          path: "$.intent.sampling.topK", kind: "dropped",
          detail: "Chat Completions has no top_k sampling parameter",
        });
      }
      for (const [index, edit] of intent.contextEdits.entries()) {
        report.record({
          path: `$.intent.contextEdits[${index}]`, kind: "dropped",
          detail: `Chat Completions has no context_management; the '${edit.kind}' directive is not forwarded upstream`,
        });
      }
      if (intent.identity.sessionId !== undefined || intent.identity.deviceId !== undefined
        || intent.identity.accountUuid !== undefined) {
        // Chat 只有一个不透明的 `user` 字段，语义是滥用检测标识，不是会话身份；
        // 把 session id 塞进去会改变上游对该字段的用法，宁可丢并留痕。
        report.record({
          path: "$.intent.identity", kind: "dropped",
          detail: "Chat Completions carries no session identity; its only identity field (`user`) means something else upstream",
        });
      }

      // 拒绝时**不构造 body**：半个非法请求体连序列化出来的机会都不该有。
      if (report.rejected) {
        return { ok: false, problems: report.drainProblems(), losses: report.drain() };
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: intent.stream.value,
        // 实测：兼容端点收到 stream_options.include_usage 才会在收尾补一个
        // choices:[] + usage 的 chunk；不带的话整条流一个 token 数都没有。
        ...(intent.stream.value ? { stream_options: { include_usage: true } } : {}),
        ...(tools.length === 0 ? {} : { tools }),
        ...(tools.length === 0 || conversation.toolset.choice.source !== "client" ? {} : { tool_choice: toolChoice }),
        ...(tools.length === 0 || conversation.toolset.parallel.source !== "client"
          ? {} : { parallel_tool_calls: conversation.toolset.parallel.value }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
        // max_tokens 而不是 max_completion_tokens：真实上行流量里 285 条请求全部用前者，
        // 兼容端点（deepseek / kimi / glm）也只认它。
        ...(intent.stopping.maxOutputTokens === undefined ? {} : { max_tokens: intent.stopping.maxOutputTokens.value }),
        ...(stop === undefined || stop.length === 0 ? {} : { stop }),
        ...(intent.sampling.temperature === undefined ? {} : { temperature: intent.sampling.temperature.value }),
        ...(intent.sampling.topP === undefined ? {} : { top_p: intent.sampling.topP.value }),
        ...(intent.serviceTier.source === "client" && intent.serviceTier.value === "priority"
          ? { service_tier: "priority" } : {}),
      };

      return {
        ok: true,
        wire: {
          url: `${options.baseUrl.replace(/\/$/u, "")}/chat/completions`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        },
        losses: report.drain(),
      };
    },

    readUpstreamResponse(response: Response): AsyncIterable<IREvent> {
      return liftOpenAIChatStream(response);
    },
  };
}

// ── lift ───────────────────────────────────────────────────────────────────

/** 未识别的 finish_reason 返回 null，由调用方产出 unhandled 而不是悄悄当成 endTurn。 */
function mapFinishReason(raw: unknown): IRStopReason | null {
  switch (raw) {
    case "stop": return "endTurn";
    case "length": return "maxTokens";
    case "max_tokens": return "maxTokens";
    case "tool_calls": return "toolUse";
    case "function_call": return "toolUse";
    case "content_filter": return "refusal";
    default: return null;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * usage 换算。**口径必须转成 Anthropic 语义**（IRUsage 的定义）：
 * OpenAI/DeepSeek 的 prompt_tokens **含**缓存命中，Anthropic 的 input_tokens **不含**。
 * 不减出来的话缓存命中会被双算。
 *
 * 三态保持（不变量 5）：字段缺席 → cacheReadTokens 不出现（上游不支持缓存）；
 * 字段在但为 0 → 保留 0（支持但没命中）。
 */
function usageFrom(raw: unknown): IRUsage | null {
  if (!isRecord(raw)) return null;
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null;
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : null;
  // DeepSeek 用 prompt_cache_hit_tokens，OpenAI 与多数兼容实现用 prompt_tokens_details.cached_tokens。
  const cached = num(promptDetails?.cached_tokens) ?? num(raw.prompt_cache_hit_tokens);
  const prompt = num(raw.prompt_tokens);
  const completion = num(raw.completion_tokens);
  if (prompt === undefined && completion === undefined && cached === undefined) return null;
  const reasoning = num(completionDetails?.reasoning_tokens);
  const cacheWrite = num(promptDetails?.cache_creation_tokens);
  return {
    // 上游偶发把 cached 报得比总输入还大时不要算出负数。
    inputTokens: prompt === undefined ? 0 : Math.max(0, prompt - (cached ?? 0)),
    outputTokens: completion ?? 0,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function classifyError(type: string, code: string, message: string, httpStatus: number | null): IRUpstreamError["kind"] {
  const text = `${code} ${message}`;
  if (/context[_ ]length|context window|maximum context|too many tokens|reduce the length/iu.test(text)) {
    return "contextLengthExceeded";
  }
  if (code === "insufficient_quota" || type === "insufficient_quota" || /quota|billing|credit balance/iu.test(text)) {
    return "quotaExhausted";
  }
  if (type === "rate_limit_error" || code === "rate_limit_exceeded" || httpStatus === 429) return "rateLimited";
  if (type === "authentication_error" || type === "permission_error" || code === "invalid_api_key"
    || httpStatus === 401 || httpStatus === 403) {
    return "permissionDenied";
  }
  if (code === "content_filter" || code === "content_policy_violation" || type === "content_policy_violation") {
    return "contentPolicy";
  }
  if (type === "server_error" || type === "api_error" || type === "overloaded_error"
    || (httpStatus !== null && (httpStatus >= 500 || httpStatus === 408))) {
    return "upstreamUnavailable";
  }
  if (type === "invalid_request_error" || (httpStatus !== null && httpStatus >= 400)) return "invalidRequest";
  return "unknown";
}

function mapUpstreamError(payload: unknown, httpStatus: number | null): IRUpstreamError {
  const holder = isRecord(payload) ? payload : {};
  const inner = isRecord(holder.error) ? holder.error : holder;
  const type = typeof inner.type === "string" ? inner.type : "";
  const code = typeof inner.code === "string" ? inner.code
    : typeof inner.code === "number" ? String(inner.code) : "";
  const message = typeof inner.message === "string" ? inner.message
    : typeof payload === "string" && payload.length > 0 ? payload
    : "upstream error";
  const kind = classifyError(type, code, message, httpStatus);
  return {
    kind, httpStatus, message,
    retryable: kind === "rateLimited" || kind === "upstreamUnavailable" || kind === "transport",
    raw: payload,
  };
}

function transportError(message: string): Extract<IREvent, { kind: "error" }> {
  return { kind: "error", error: { kind: "transport", httpStatus: null, message, retryable: true, raw: null } };
}

function liftLoss(path: string, kind: IRLoss["kind"], detail: string): Extract<IREvent, { kind: "loss" }> {
  return { kind: "loss", loss: { stage: "lift", provider: PROVIDER, path, kind, detail } };
}

/**
 * IR part 索引分配器。Chat 的流里没有块索引：文本、推理与每个 tool_calls[].index
 * 各自占一个 IR part，索引在**首次出现**时分配，之后复用。
 */
class PartIndexer {
  #next = 0;
  #text: number | null = null;
  #thinking: number | null = null;
  readonly #open = new Set<number>();

  allocate(): number {
    const index = this.#next++;
    this.#open.add(index);
    return index;
  }
  text(): { index: number; started: boolean } {
    if (this.#text !== null) return { index: this.#text, started: true };
    this.#text = this.allocate();
    return { index: this.#text, started: false };
  }
  thinking(): { index: number; started: boolean } {
    if (this.#thinking !== null) return { index: this.#thinking, started: true };
    this.#thinking = this.allocate();
    return { index: this.#thinking, started: false };
  }
  close(): number[] {
    const indices = [...this.#open].sort((left, right) => left - right);
    this.#open.clear();
    return indices;
  }
}

interface ToolFragment {
  index: number | null;
  id: string;
  name: string;
  buffer: string;
}

/** delta 里认得的键。其余键一律走 unhandled —— 这是上游漂移的探针。 */
const KNOWN_DELTA_KEYS = new Set([
  "role", "content", "reasoning_content", "reasoning", "tool_calls", "refusal",
]);

type ChunkShape = "error" | "choices" | "usageOnly" | "unknown";

function classifyChunk(payload: Record<string, unknown>, hasUsage: boolean): ChunkShape {
  if (isRecord(payload.error) || typeof payload.error === "string") return "error";
  if (Array.isArray(payload.choices) && payload.choices.length > 0) return "choices";
  if (hasUsage) return "usageOnly";
  return "unknown";
}

async function* liftOpenAIChatStream(response: Response): AsyncGenerator<IREvent> {
  // 非 2xx：整体读出来当一次性错误，不进 SSE 解析。
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapUpstreamError(tryParseJson(text) ?? text, response.status) };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    yield* liftNonStreaming(response);
    return;
  }

  const indexer = new PartIndexer();
  const tools = new Map<number, ToolFragment>();
  let sawTerminal = false;
  let announced = false;

  for await (const frame of iterateSse(response)) {
    const data = frame.data.trim();
    // [DONE] 是哨兵，不是终止事件：它证明连接正常收尾，不证明这一轮完成了。
    if (data === "[DONE]") continue;
    const payload = tryParseJson<Record<string, unknown>>(frame.data);
    if (payload === null || !isRecord(payload)) {
      yield { kind: "unhandled", rawType: frame.event ?? "<unparseable>", raw: frame.data };
      continue;
    }

    if (!announced) {
      announced = true;
      yield { kind: "messageStart", model: typeof payload.model === "string" ? payload.model : "" };
    }

    // usage 与形状正交：既可能单独成帧（stream_options.include_usage），也可能挂在有
    // choices 的帧上。先取一次，之后的 switch 只管形状。
    const usage = usageFrom(payload.usage);
    if (usage !== null) yield { kind: "usage", usage };

    switch (classifyChunk(payload, usage !== null)) {
      case "error":
        sawTerminal = true;
        yield { kind: "error", error: mapUpstreamError(payload, null) };
        break;

      case "usageOnly":
        break;

      case "choices": {
        const choices = payload.choices as unknown[];
        for (const rawChoice of choices) {
          if (!isRecord(rawChoice)) {
            yield { kind: "unhandled", rawType: "choice", raw: rawChoice };
            continue;
          }
          const choiceIndex = num(rawChoice.index) ?? 0;
          if (choiceIndex !== 0) {
            // n > 1 在 IR 里没有对应物（响应是一条回合）。多出来的候选不能静默丢。
            yield { kind: "unhandled", rawType: `choice:index=${choiceIndex}`, raw: rawChoice };
            continue;
          }
          const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
          for (const [key, value] of Object.entries(delta)) {
            switch (key) {
              case "role":
                break;
              case "content": {
                // 实测：`content` 常态是 null（108115 条 chunk 里 107486 条带这个键），
                // null 不是文本也不是未知字段。
                if (typeof value !== "string" || value.length === 0) break;
                const slot = indexer.text();
                if (!slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "text", text: "" } };
                yield { kind: "partDelta", index: slot.index, delta: { kind: "text", text: value } };
                break;
              }
              case "reasoning_content":
              case "reasoning": {
                if (typeof value !== "string" || value.length === 0) break;
                const slot = indexer.thinking();
                if (!slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "thinking", text: "" } };
                yield { kind: "partDelta", index: slot.index, delta: { kind: "thinking", text: value } };
                break;
              }
              case "refusal": {
                if (typeof value !== "string" || value.length === 0) break;
                const slot = indexer.text();
                if (!slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "text", text: "" } };
                yield { kind: "partDelta", index: slot.index, delta: { kind: "text", text: value } };
                yield liftLoss("$.choices[0].delta.refusal", "substituted",
                  "refusal text surfaced as assistant text; IR has no separate refusal part");
                break;
              }
              case "tool_calls": {
                if (!Array.isArray(value)) {
                  yield { kind: "unhandled", rawType: "delta:tool_calls", raw: value };
                  break;
                }
                for (const rawCall of value) {
                  if (!isRecord(rawCall)) {
                    yield { kind: "unhandled", rawType: "delta:tool_calls[]", raw: rawCall };
                    continue;
                  }
                  const slot = num(rawCall.index) ?? 0;
                  const fragment = tools.get(slot) ?? { index: null, id: "", name: "", buffer: "" };
                  // 实测：续帧带的是 id:"" / function.name:""，不是省略这两个键，
                  // 所以只在**非空**时覆盖，否则首帧的 id 会被续帧抹掉。
                  if (typeof rawCall.id === "string" && rawCall.id.length > 0) fragment.id = rawCall.id;
                  const fn = isRecord(rawCall.function) ? rawCall.function : {};
                  if (typeof fn.name === "string" && fn.name.length > 0) fragment.name = fn.name;
                  const args = typeof fn.arguments === "string" ? fn.arguments : "";

                  if (fragment.index === null && fragment.name.length > 0) {
                    fragment.index = indexer.allocate();
                    tools.set(slot, fragment);
                    yield {
                      kind: "partStart", index: fragment.index,
                      part: {
                        kind: "toolCall",
                        call: {
                          id: fragment.id.length > 0 ? fragment.id : `call_${slot}`,
                          toolRef: { group: null, name: fragment.name },
                          input: { kind: "json", value: {} },
                        },
                      },
                    };
                    // 名字到达前先攒着的分片在这里补发，顺序不变。
                    const pending = fragment.buffer + args;
                    fragment.buffer = "";
                    if (pending.length > 0) {
                      yield { kind: "partDelta", index: fragment.index, delta: { kind: "toolInputJson", json: pending } };
                    }
                    continue;
                  }
                  tools.set(slot, fragment);
                  if (args.length === 0) continue;
                  if (fragment.index === null) { fragment.buffer += args; continue; }
                  yield { kind: "partDelta", index: fragment.index, delta: { kind: "toolInputJson", json: args } };
                }
                break;
              }
              default:
                if (KNOWN_DELTA_KEYS.has(key)) break;
                // 不变量 4：没匹配上的字段是流里的元素，不是 switch 的黑洞。
                yield { kind: "unhandled", rawType: `delta:${key}`, raw: { [key]: value } };
            }
          }

          if (rawChoice.finish_reason === null || rawChoice.finish_reason === undefined) continue;
          // Chat 流的终止信号就是 finish_reason，没有独立的终止帧。
          const reason = mapFinishReason(rawChoice.finish_reason);
          if (reason === null) {
            yield { kind: "unhandled", rawType: `finish_reason:${String(rawChoice.finish_reason)}`, raw: rawChoice };
          }
          for (const fragment of tools.values()) {
            if (fragment.index !== null) continue;
            yield liftLoss("$.choices[0].delta.tool_calls", "dropped",
              `tool call fragment ${fragment.id.length > 0 ? fragment.id : "<no id>"} never carried a function name and cannot be reconstructed`);
          }
          for (const index of indexer.close()) yield { kind: "partEnd", index };
          sawTerminal = true;
          yield { kind: "messageStop", reason: reason ?? "endTurn" };
        }
        break;
      }

      default:
        yield { kind: "unhandled", rawType: typeof payload.object === "string" ? payload.object : "<no-shape>", raw: payload };
    }
  }

  // 上游把流掐断却没发 finish_reason：必须显式终止，否则调用方看到的是「200 但空」。
  if (!sawTerminal) {
    for (const index of indexer.close()) yield { kind: "partEnd", index };
    yield transportError("upstream stream ended without a finish_reason");
  }
}

/**
 * 非流式：一次性 chat.completion JSON 转成**等价事件序列**，
 * 下游 encode 不需要区分两条路径。
 */
async function* liftNonStreaming(response: Response): AsyncGenerator<IREvent> {
  const text = await response.text();
  const payload = tryParseJson<Record<string, unknown>>(text);
  if (payload === null || !isRecord(payload)) {
    yield transportError("upstream returned a non-streaming body that is not JSON");
    return;
  }
  if (isRecord(payload.error) || typeof payload.error === "string") {
    yield { kind: "error", error: mapUpstreamError(payload, response.status) };
    return;
  }

  yield { kind: "messageStart", model: typeof payload.model === "string" ? payload.model : "" };

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    // 非流式的终止信号就是 choices 本身；没有它就没有回合可言。
    yield {
      kind: "error",
      error: {
        kind: "unknown", httpStatus: response.status, retryable: false,
        message: "upstream returned a non-streaming completion with no choices",
        raw: payload,
      },
    };
    return;
  }
  for (const extra of choices.slice(1)) {
    yield { kind: "unhandled", rawType: "choice:index>0", raw: extra };
  }

  const message = isRecord(choice.message) ? choice.message : {};
  let index = 0;
  const emit = function* (part: IRPart): Generator<IREvent> {
    yield { kind: "partStart", index, part };
    yield { kind: "partEnd", index };
    index += 1;
  };

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    yield* emit({ kind: "thinking", text: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    yield* emit({ kind: "text", text: message.content });
  }
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    yield* emit({ kind: "text", text: message.refusal });
    yield liftLoss("$.choices[0].message.refusal", "substituted",
      "refusal text surfaced as assistant text; IR has no separate refusal part");
  }
  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      if (!isRecord(rawCall)) { yield { kind: "unhandled", rawType: "tool_call", raw: rawCall }; continue; }
      const fn = isRecord(rawCall.function) ? rawCall.function : {};
      const name = typeof fn.name === "string" ? fn.name : "";
      const id = typeof rawCall.id === "string" ? rawCall.id : "";
      if (name.length === 0 || id.length === 0) {
        yield { kind: "unhandled", rawType: "tool_call", raw: rawCall };
        continue;
      }
      const argumentsText = typeof fn.arguments === "string" ? fn.arguments : "";
      let parsed: unknown;
      try { parsed = argumentsText.length === 0 ? {} : JSON.parse(argumentsText); } catch { parsed = undefined; }
      yield* emit({
        kind: "toolCall",
        call: {
          id, toolRef: { group: null, name },
          // 解析不出对象就保留原文当 freeform 入参，不硬造一个空对象把内容吃掉。
          input: isRecord(parsed) ? { kind: "json", value: parsed } : { kind: "text", text: argumentsText },
        },
      });
    }
  }

  const usage = usageFrom(payload.usage);
  if (usage !== null) yield { kind: "usage", usage };

  const reason = mapFinishReason(choice.finish_reason);
  if (reason === null && choice.finish_reason !== null && choice.finish_reason !== undefined) {
    yield { kind: "unhandled", rawType: `finish_reason:${String(choice.finish_reason)}`, raw: choice };
  }
  yield { kind: "messageStop", reason: reason ?? "endTurn" };
}
