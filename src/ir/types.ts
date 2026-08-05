import type { OutboxResponseReadInterceptionOptions } from "./ir_message_interception_extensions.ts";

/**
 * L0/L1/L2 —— IR 的全部类型契约。
 *
 * 设计依据是真实流量，不是任何一家的 wire 文档：
 * 807 条全量归档（anthropic_messages 611 / openai_chat_completions 116 / openai_responses 80，
 * 2026-08-01..04，turn_index 最深 1689）+ 5 天 108 万行网关日志。逐条证据见 docs/EVIDENCE.md。
 *
 * 五条不变量（每条对应一个已确认的真实故障）：
 *   1. 关联用 id，不用位置        —— 消灭 tool_result「必须紧邻/必须最前」的排列战争
 *   2. 未知必须显式装箱           —— 索引签名夹带会让新增出口时字段静默蒸发
 *   3. 有损必须留痕               —— max_tokens 对 codex 出口静默失效那类问题
 *   4. 响应是可拉取的事件流        —— 未识别事件是流里的元素，不是 switch 的黑洞
 *   5. 能力是静态声明             —— 不从运行时值反推（usage 三态坍缩）
 */

// ═══════════════════════════════════════════════════════════════════════════
// 通用
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 入口协议 —— **定值封闭集**，本库默认支持的主流 Agent 对话入口只有这三种。
 *
 * 常量数组是唯一授权定义，类型从它派生（与下面的 `IR_CAPABILITIES` 同构）。手写联合做不到
 * 运行时枚举，于是每个需要「全部协议」的地方都会自己抄一份：路由表、注册表、测试各抄一遍，
 * 少改一处没有任何东西会报错。从这里派生之后，`Record<IRProtocol, T>` 的键就是编译期的穷举证明。
 */
export const IR_PROTOCOLS = [
  "anthropic_messages", "openai_responses", "openai_chat_completions",
] as const;

export type IRProtocol = (typeof IR_PROTOCOLS)[number];

/** 值的来源。区分「客户端明确要求」与「网关替他决定」——两者冲突时的处理完全不同。 */
export type IRSource = "client" | "gateway-default" | "gateway-forced";

export interface IRValued<T> {
  readonly value: T;
  readonly source: IRSource;
}

export const clientValue = <T>(value: T): IRValued<T> => ({ value, source: "client" });
export const defaultValue = <T>(value: T): IRValued<T> => ({ value, source: "gateway-default" });

// ═══════════════════════════════════════════════════════════════════════════
// L0 — 会话骨架
// ═══════════════════════════════════════════════════════════════════════════

export interface IRBlob {
  readonly source:
    | { readonly kind: "base64"; readonly data: string }
    | { readonly kind: "url"; readonly url: string };
  readonly mediaType: string;
  /** 已知字节数。让 outbox 不解码也能做尺寸预算。 */
  readonly bytes?: number;
}

/**
 * 缓存断点。语料实证 cache_control 出现在 system / user / assistant / tool_use / tool_result
 * 五个位置（ephemeral，共 1027 次），所以它是 **part 级标注**，不是 message 级开关。
 */
export interface IRCacheBreakpoint {
  readonly scope: "ephemeral";
  readonly ttlSeconds?: number;
}

export interface IRPartBase {
  /** 该 part 之后设一个缓存断点。不支持缓存的 outbox 直接忽略并记一条 degraded loss。 */
  readonly cacheBreakpoint?: IRCacheBreakpoint;
}

export interface IRToolRef {
  /** 命名空间/分组。null = 顶层工具。**不是**拍平后的字符串前缀。 */
  readonly group: string | null;
  readonly name: string;
}

export type IRToolInput =
  /** 结构化参数，对应 JSON Schema 工具。 */
  | { readonly kind: "json"; readonly value: Record<string, unknown> }
  /** 自由文本参数，对应 Anthropic custom / codex apply_patch 这类 freeform 工具。 */
  | { readonly kind: "text"; readonly text: string };

export interface IRToolCall {
  readonly id: string;
  readonly toolRef: IRToolRef;
  readonly input: IRToolInput;
  /**
   * 发起方标识。Anthropic `tool_use.caller` 实测形态是 `{type:'direct'}` 的**对象**，
   * 不是字符串；subagent 变体的完整形状尚未在语料中出现，因此 `kind` 取判别位、
   * `raw` 原样保留，能表达它的 outbox 可以无损还原，不能的记 loss。
   */
  readonly caller?: { readonly kind: string; readonly raw: unknown };
}

/**
 * 工具结果。
 * - 靠 `callId` 关联，**与位置无关**（不变量 1）
 * - `status` 显式表达三态；语料里 is_error=true 出现 709 次，错误结果是常态不是异常
 * - `parts` 而非 string：语料里 625 条结果是数组，其中 94 条含图片
 */
export interface IRToolResult {
  readonly callId: string;
  readonly parts: readonly IRPart[];
  readonly status: "ok" | "error" | "missing";
}

export type IRPart =
  | (IRPartBase & { readonly kind: "text"; readonly text: string })
  | (IRPartBase & { readonly kind: "image"; readonly media: IRBlob })
  | (IRPartBase & { readonly kind: "document"; readonly media: IRBlob; readonly title?: string })
  /** 模型思考。`signature` 是回传时的完整性凭据，丢了会被上游拒。 */
  | (IRPartBase & { readonly kind: "thinking"; readonly text: string; readonly signature?: string })
  | (IRPartBase & { readonly kind: "redactedThinking"; readonly data: string })
  | (IRPartBase & { readonly kind: "toolCall"; readonly call: IRToolCall })
  | (IRPartBase & { readonly kind: "toolResult"; readonly result: IRToolResult })
  /**
   * 逃生舱（不变量 2）。任何 outbox 遇到它都必须**显式决定**，类型系统强制写这个 case ——
   * 这正是 `[key: string]: unknown` 做不到的。
   *
   * 但「决定」的合法取值只有两个：**同源透传**（无损），或**拒绝**
   * （`unrepresentablePart`）。**不含「丢弃并记 loss」** —— 客户端明确送来的内容没到达
   * 模型，就是「本该生效的输入被丢了」，按 Failure surfaces 必须 raise 而不是 drop。
   * 想要旧的丢弃行为，调用方去 repair 层显式挂一条，那是策略。
   */
  | (IRPartBase & {
      readonly kind: "opaque";
      readonly origin: IRProtocol;
      readonly tag: string;
      readonly raw: unknown;
    });

/**
 * 模型**产出**的 part 种类。是 `IRPart` 的真子集：image / document / toolResult / opaque
 * 是客户端往上送的形态，模型不会生成它们。
 *
 * 单独收窄一层，让「响应里出现图片」在编译期就不可能，而不是靠每个 encoder 运行时
 * `return null` 兜底 —— 那种兜底写几遍就漏几遍。
 */
export type IRResponsePart = Extract<IRPart, { kind: "text" | "thinking" | "redactedThinking" | "toolCall" }>;

/**
 * 一个回合。`role` 只有两个值：语料里的 `role:'system'`（1537 次）与 Responses 的
 * `role:'developer'`（9 次）都是 wire 层的编码技巧，decode 时归位到 `conversation.system`；
 * OpenAI 的 `role:'tool'`（2355 次）归位成 user turn 里的 toolResult part。
 *
 * `parts` 是**无约束序列**：语料里 assistant 回合有 27 种形态，包括 `text+text+tool_use`
 * 和一条消息 9 个并行 tool_use，任何「最多一个 text」「工具调用必须在末尾」的假设都会被打破。
 */
export interface IRTurn<TPart extends IRPart = IRPart> {
  readonly role: "user" | "assistant";
  readonly parts: readonly TPart[];
}

export type IRJsonSchema = Record<string, unknown>;

export type IRTool =
  | {
      readonly kind: "function";
      readonly ref: IRToolRef;
      readonly description: string;
      readonly schema: IRJsonSchema;
      /** 上游按 schema 严格校验参数（Responses 的 strict）。 */
      readonly strict?: boolean;
      /** 定义延迟加载（Anthropic defer_loading），是提示不是保证。 */
      readonly deferLoading?: boolean;
    }
  /** 自由文本入参工具（Anthropic custom / codex apply_patch）。 */
  | { readonly kind: "freeform"; readonly ref: IRToolRef; readonly description: string }
  /** 上游内建工具（computer_*、web_search…）。只有身份，执行在上游。 */
  | {
      readonly kind: "builtin";
      readonly ref: IRToolRef;
      readonly builtin: string;
      readonly config?: Record<string, unknown>;
    };

/** 分组是结构，不是命名约定 —— 消灭 `${namespace}${name}` + 平行 Map 的往返。 */
export interface IRToolGroup {
  readonly name: string;
  readonly members: readonly string[];
}

export type IRToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "none" }
  | { readonly kind: "required" }
  | { readonly kind: "specific"; readonly ref: IRToolRef };

export interface IRToolset {
  readonly tools: readonly IRTool[];
  readonly groups: readonly IRToolGroup[];
  readonly choice: IRValued<IRToolChoice>;
  /** 允许上游一次发起多个工具调用。语料里并行调用最高 9 个，是常态。 */
  readonly parallel: IRValued<boolean>;
}

export interface IRConversation {
  /** 永远是 parts 数组。`system` 的 string 形态（语料 148 次）在 decode 时就消灭。 */
  readonly system: readonly IRPart[];
  readonly turns: readonly IRTurn[];
  readonly toolset: IRToolset;
}

// ═══════════════════════════════════════════════════════════════════════════
// L1 — 意图层
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 推理强度档。常量数组是唯一授权定义 —— 因为 inbox 要**在运行时逐个校验**客户端送来的
 * 字符串（`parseEffort`），手写联合逼着那边自己抄一份档位清单，抄漏一档的后果是：客户端
 * 明确要求的 effort 被解成 undefined 静默丢掉，正是本文件反复强调的「有损发生在 inbox」。
 *
 * 从这里派生之后，加一档会同时点亮三个出口的 `Record<IREffort, …>` 换算表，逼每家表态。
 */
export const IR_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type IREffort = (typeof IR_EFFORTS)[number];

/**
 * 推理开关档。模式来自实测：
 *   `{type:'disabled'}`                       → disabled
 *   `{type:'adaptive', display:'summarized'}` → adaptive（Claude Code 2.1.x 的默认）
 *   `{type:'enabled', budget_tokens:N}`       → enabled
 */
export type IRReasoningMode = "disabled" | "auto" | "adaptive" | "enabled";

/** 思考对客户端的可见形态。Anthropic `thinking.display` 与 Responses `reasoning.summary` 同源。 */
export type IRReasoningDisplay = "hidden" | "summarized" | "full";

/**
 * 推理意图。
 *
 * `mode` / `effort` / `budgetTokens` 是**三个正交维度**，不是一个判别联合 —— 语料实证
 * `thinking:{type:'adaptive',display:'summarized'}` 与 `output_config:{effort:'high'}`
 * 在同一条请求里共存（Claude Code 2.1.x 的常规形态）。把它们压成互斥的 union 会在 decode
 * 阶段丢掉其中一个，就是把损失提前到了 inbox —— 两个都要原样带到出口再各自表态。
 *
 * `effort` 与 `budgetTokens` 保持各自的原始表示，**不在 inbox 互转**：
 * 谁的上游要哪种，谁在 outbox 自己换算并记 loss。
 */
export interface IRReasoning {
  readonly mode: IRReasoningMode;
  readonly effort?: IREffort;
  readonly budgetTokens?: number;
  readonly display: IRReasoningDisplay;
}

/** 结构化输出。语料实证 `output_config.format = {type:'json_schema', schema}`。 */
export type IROutputFormat =
  | { readonly kind: "text" }
  | { readonly kind: "jsonSchema"; readonly name?: string; readonly schema: IRJsonSchema; readonly strict?: boolean };

/**
 * 上下文管理编辑指令。实测 `context_management.edits = [{type:'clear_thinking_20251015', keep:'all'}]`。
 * 这是**客户端对历史的处置意图**，不是内容本身，所以留在 L1 而不是 L0。
 */
export interface IRContextEdit {
  readonly kind: "clearThinking" | "clearToolResults" | "unknown";
  readonly keep: "all" | "none" | { readonly lastTurns: number };
  /** 原始 wire 指令，供能表达它的 outbox 无损还原。 */
  readonly raw: unknown;
}

export interface IRSampling {
  readonly temperature?: IRValued<number>;
  readonly topP?: IRValued<number>;
  readonly topK?: IRValued<number>;
}

export interface IRStopping {
  /** 单次输出上限。Anthropic 必填，Chat 可选，Codex Responses 直接拒收 —— 差异由 outbox 记 loss。 */
  readonly maxOutputTokens?: IRValued<number>;
  readonly stopSequences?: IRValued<readonly string[]>;
}

/** 会话身份。语料里 Claude Code 把它塞进 `metadata.user_id` 的 JSON 字符串里。 */
export interface IRSessionIdentity {
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly accountUuid?: string;
}

export interface IRIntent {
  readonly reasoning: IRValued<IRReasoning>;
  readonly outputFormat: IRValued<IROutputFormat>;
  readonly serviceTier: IRValued<"standard" | "priority">;
  readonly sampling: IRSampling;
  readonly stopping: IRStopping;
  readonly contextEdits: readonly IRContextEdit[];
  readonly stream: IRValued<boolean>;
  readonly identity: IRSessionIdentity;
}

// ═══════════════════════════════════════════════════════════════════════════
// L2 — 能力与损失
// ═══════════════════════════════════════════════════════════════════════════

export const IR_CAPABILITIES = [
  "stream", "nonStream",
  "systemPrompt", "multiTurn",
  "image", "document",
  "thinking", "thinkingSignature", "reasoningEffort", "reasoningBudget",
  "toolFunction", "toolFreeform", "toolBuiltin", "toolGroup", "toolParallel", "toolChoiceSpecific",
  "toolResultImage", "toolResultError",
  "structuredOutput", "cacheBreakpoint", "contextEdit",
  "maxOutputTokens", "stopSequences", "temperature", "topP", "topK", "serviceTier",
] as const;

export type IRCapability = (typeof IR_CAPABILITIES)[number];

export interface IRCapabilityNeed {
  readonly capability: IRCapability;
  /** 触发它的 IR 路径，用于把 422 指到具体位置而不是笼统报错。 */
  readonly paths: readonly string[];
}

/**
 * 目标 wire **强制要求**的 IR 字段 —— 可登记的封闭集。
 *
 * 与 `IR_CAPABILITIES` 是**两个正交问题**，混用其中一个回答另一个正是 DEFECT-10 的根因：
 *
 *   supports  —— 目标**认识**这个字段吗？（认识 → 可以发）
 *   mandatory —— 目标**要求**这个字段吗？（要求 → 不发就编不出合法 body）
 *
 * 「认识」不蕴含「要求」：Anthropic 强制 `max_tokens`，Gemini 只是接受。给一个只是接受它
 * 的上游补一个默认值，等于凭空造出一条它本来没有的约束 —— 实测代价是 18/807 条真实
 * gemini 请求从「能编译」变成 422（CloudCode 把 thinkingBudget 算进 maxOutputTokens）。
 *
 * 只登记**有拒绝逻辑为证**的字段：一个成员进这张表的门槛是「某个出口在缺它时会抛
 * `requiredFieldMissing`」。没有拒绝逻辑的字段不是「必填」，只是「可选」。
 */
export const IR_MANDATORY_FIELDS = ["maxOutputTokens"] as const;

export type IRMandatoryField = (typeof IR_MANDATORY_FIELDS)[number];

/**
 * 每个出口对每个必填字段的表态。**映射类型而不是集合**：集合漏了一项没人会报错，
 * 映射类型让「新增一个必填字段」当场点亮全部六个出口的声明，逼每家逐个表态。
 */
export type IRMandatoryFieldTable = Readonly<Record<IRMandatoryField, boolean>>;

/**
 * Outbox 对 IR wire 编译的静态声明。这里只放能由所有 Outbox 共同解释的事实：
 * 表达能力、明确有损的表达与 wire 强制字段。
 *
 * 目标厂商的私有策略、账户行为或内容分类规则不属于这份契约；它们由相应 Outbox 的
 * `writeOutboxRequest` 在自己的模块内处理，不能让其他 Outbox 为一个私有事实增加占位字段。
 */
export interface IROutboxProfile {
  readonly supports: ReadonlySet<IRCapability>;
  /** 能承载但有损（如 toolGroup 靠拍平实现）。放行，但强制记 loss。 */
  readonly lossy: ReadonlySet<IRCapability>;
  /**
   * 目标**强制要求**哪些 IR 字段。判据是 wire 事实，不是偏好：
   * 缺了这个字段，`writeOutboxRequest` 会带 `requiredFieldMissing` 拒绝。
   */
  readonly mandatory: IRMandatoryFieldTable;
}

/** 损失的四种形态。语料回放要在运行时枚举它们核对，所以是常量数组而非手写联合。 */
export const IR_LOSS_KINDS = ["dropped", "degraded", "substituted", "truncated"] as const;

export type IRLossKind = (typeof IR_LOSS_KINDS)[number];

export interface IRLoss {
  readonly stage: "inbox" | "outbox";
  readonly outbox: string | null;
  /** IR 路径，如 `$.intent.stopping.maxOutputTokens`。 */
  readonly path: string;
  readonly kind: IRLossKind;
  readonly detail: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 请求与响应
// ═══════════════════════════════════════════════════════════════════════════

export interface IRRequest {
  readonly traceId: string;
  readonly protocol: IRProtocol;
  readonly model: string;
  readonly conversation: IRConversation;
  readonly intent: IRIntent;
  /** 由 L0/L1 推导，不手写。 */
  readonly requires: readonly IRCapabilityNeed[];
}

export type IRStopReason =
  | "endTurn" | "maxTokens" | "stopSequence" | "toolUse" | "refusal" | "aborted" | "error";

/**
 * 用量。**口径取 Anthropic 语义：`inputTokens` 不含缓存命中部分**，缓存单列。
 *
 * 这条必须写死在类型上，因为两家 wire 的口径是相反的：OpenAI 的 `prompt_tokens` /
 * Responses 的 `input_tokens` **都包含** cached（实测 40,926 个样本零反例，缓存占比
 * 62%–91%）。lift 进来时要减出去，lower/encode 出去时要加回来 —— 少做任何一边，
 * 输入 token 就会虚增或少报最高九成，下游 harness 的上下文压缩阈值全部算错。
 */
export interface IRUsage {
  /** 不含缓存命中。换算见本接口顶部说明。 */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 三态：undefined = 上游不支持缓存；0 = 支持但没命中；>0 = 命中。 */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** 出站到「input 含缓存」口径的 wire 时用它加回去。加回来只此一处，不许各写各的。 */
export function inputTokensIncludingCache(usage: IRUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0);
}

export interface IROutboxError {
  readonly kind:
    | "invalidRequest" | "permissionDenied" | "rateLimited" | "quotaExhausted"
    | "contextLengthExceeded" | "contentPolicy" | "outboxUnavailable" | "transport" | "unknown";
  readonly httpStatus: number | null;
  readonly message: string;
  readonly retryable: boolean;
  readonly raw: unknown;
}

/**
 * 响应事件流（不变量 4）。`lift` 返回 AsyncIterable<IREvent> 而不是往 emitter 里推 ——
 * push 契约的 switch 缺省分支是黑洞：实测一天 126 次 context_length_exceeded 全被静默
 * 跳过，最后以「200 但空」的形状返回，调用方无法与「没话说」区分，只能盲重试到 retry cap。
 * `unhandled` 让未识别事件成为流里的一等元素，不可能消失。
 */
export type IREvent =
  | { readonly kind: "messageStart"; readonly model: string }
  | { readonly kind: "partStart"; readonly index: number; readonly part: IRPart }
  | { readonly kind: "partDelta"; readonly index: number; readonly delta: IRPartDelta }
  | { readonly kind: "partEnd"; readonly index: number }
  | { readonly kind: "usage"; readonly usage: IRUsage }
  | { readonly kind: "messageStop"; readonly reason: IRStopReason }
  | { readonly kind: "error"; readonly error: IROutboxError }
  | { readonly kind: "loss"; readonly loss: IRLoss }
  | { readonly kind: "unhandled"; readonly rawType: string; readonly raw: unknown }
  /**
   * 首个语义产出已经下发 —— **提交点**。由 stream guard 注入，encoder 忽略它。
   *
   * 这是长流容错的枢纽：提交之前上游出错还能换号重试、还能改状态码；提交之后字节已经
   * 在下游手里，两者都做不到了，只能在 200 流里补一个协议内的 error 事件收尾。
   * 把它做成流里的一等事件而不是旁路布尔，是因为「能不能重试」这个判断必须与事件顺序严格对齐。
   */
  | { readonly kind: "committed" }
  /**
   * 计时器驱动的保活提示。由 stream guard 按节律注入，各 encoder 渲染成自己协议的形态
   * （Anthropic 的 `event: ping`、OpenAI 的 SSE 注释行）。
   *
   * **必须计时器驱动，不能数据驱动。** 生产实证：上游彻底静默正是保活唯一要顶的场景，
   * 一旦把它挂在数据分支上，它就恰好在最该工作的时候停摆。
   */
  | { readonly kind: "heartbeat" };

export type IRPartDelta =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "thinkingSignature"; readonly signature: string }
  | { readonly kind: "toolInputJson"; readonly json: string }
  | { readonly kind: "toolInputText"; readonly text: string };

// ═══════════════════════════════════════════════════════════════════════════
// 契约
// ═══════════════════════════════════════════════════════════════════════════

export interface ClientRequestReadResult {
  readonly request: IRRequest;
  readonly losses: readonly IRLoss[];
}

export type IRWireBody = string | Uint8Array<ArrayBuffer>;

export interface IRWireRequest<TBody extends IRWireBody = string> {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  /**
   * 文本 wire 直接用 string；二进制协议（Connect/protobuf 等）保留原始字节。
   * 传输层可以不经协议特判地把此值交给 fetch，绝不能把二进制先 base64 化再发送。
   */
  readonly body: TBody;
}

/**
 * 目标 wire 承载不了某个 IR 概念时的拒绝理由。
 *
 * `kind` 是稳定判别位，供调用方分派（例如决定挂哪条 repair）；`detail` 写给人看，
 * 不参与分派。`path` 必须精确到 IR 位置 —— 拒绝的价值全在于「是哪个字段」。
 */
export const IR_BUILD_PROBLEM_KINDS = [
  /** 目标 wire 强制要求，而 IR 里没有（如 Anthropic 的 max_tokens）。 */
  "requiredFieldMissing",
  /**
   * IR 里**有**这个值，但目标 wire 装不下这个取值 —— 取值域、上下界、或**跨字段组合**。
   *
   * 与 `requiredFieldMissing` 的分界只有一句话：**缺不缺**。缺了才是 missing；
   * 值在、只是它与 wire 的约束冲突，是 unsatisfiable。两者在 wire 上的补法完全不同：
   * 前者要有人补一个值，后者要有人改已有的值（或改与它冲突的那个字段）。
   *
   * 实例：CloudCode 把 thinkingBudget 算进 maxOutputTokens，客户端的 max_tokens 低于
   * `budget + 可见正文下限` 时，两个字段各自都合法，是**组合**无解 —— 什么都没缺。
   */
  "unsatisfiableValue",
  /** 声明了工具调用但历史里没有对应结果，目标 wire 不接受悬空。 */
  "danglingToolCall",
  /** 工具结果找不到对应调用。 */
  "orphanToolResult",
  /** 某个 part 在目标 wire 里根本没有位置。 */
  "unrepresentablePart",
] as const;

export type IRBuildProblemKind = (typeof IR_BUILD_PROBLEM_KINDS)[number];

export interface IRBuildProblem {
  readonly kind: IRBuildProblemKind;
  readonly path: string;
  readonly detail: string;
}

/**
 * 出站请求的构造结果 —— **编译或拒绝**。
 *
 * Core 不发明内容、不补默认值：目标 wire 表达不了就带精确 IR 路径拒绝，
 * 绝不发一个非法 body 去换回一个语义模糊的 4xx。想要「替我兜着」的调用方
 * 显式 compose `src/repair`，那是策略，不是编译。
 *
 * 判别联合而不是抛异常：失败是这个函数的**正常返回值之一**，调用方必须表态。
 */
export type OutboxRequestBuildResult<TBody extends IRWireBody = string> =
  | {
      readonly ok: true;
      readonly wire: IRWireRequest<TBody>;
      /** 承载了但有损。是关于目标能力的事实，不是策略。 */
      readonly losses: readonly IRLoss[];
    }
  | {
      readonly ok: false;
      readonly problems: readonly IRBuildProblem[];
      /** 拒绝之前已经记下的有损条目，一并交出，便于调用方一次看全。 */
      readonly losses: readonly IRLoss[];
    };

export interface IROutbox<TBody extends IRWireBody = string> {
  readonly profile: IROutboxProfile;
  writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult<TBody>>;
  readOutboxResponse(response: Response, options?: OutboxResponseReadInterceptionOptions): AsyncIterable<IREvent>;
}
