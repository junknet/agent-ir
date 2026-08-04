/**
 * Repair 层契约 —— 「网关替客户端做决定」的**可穷举封闭集**。
 *
 * 分界线只有一条，本层的全部取舍都由它推出：
 *   「目标协议真的没有这个位置」是**编译事实** → 留在 Core（IRLoss / 准入拒绝）；
 *   「我替你决定怎么办」是**策略**            → 归这一层，由调用方显式 compose。
 *
 * 由此得到三条硬性质：
 *   1. **默认什么都不修**（`IR_REPAIR_POLICY_NONE`）。Core 必须确定性，修复是显式选择；
 *      策略里「有这个键」= 启用，「没这个键」= 不修 —— 不存在 `enabled:false` 这种半开状态。
 *   2. **种类是封闭集**。`IR_REPAIR_KINDS` 是唯一授权定义，`IRRepairKind` 由它派生，
 *      规格表 `IRRepairSpecTable` 是以它为键的映射类型 —— 少一种 / 多一种 / 拼错一种
 *      都是编译错误，不需要任何人「记得」去同步第二份清单。
 *   3. **每种修复都是纯函数**：`IRRequest → { request, applied }`，入参对象一个字段都不改。
 *
 * 新增一种修复的完整动作：在 `IR_REPAIR_KINDS` 里登记一个名字，然后跟着编译错误走完
 * `IRRepairOptionsByKind`（它的选项形状）与 `IR_REPAIR_SPECS`（它的规格与实现）。
 */
import type { IRCapability, IREgressProfile, IRLoss, IRRequest } from "../ir/types.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 种类 —— 唯一授权定义
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 全部修复种类。新增一种必须在这里登记 —— 这是唯一授权定义。
 *
 * **数组顺序 = 流水线顺序**，不另立第二份排序表（那必然漂移）。顺序不是随意的：
 *   - 先摘掉孤儿结果，再补悬空调用：否则「孤儿」与「悬空」会互相误判；
 *   - 内容改写（补空结果、模态降级）在回合清理之前：改写可能让一个回合变空/变不空；
 *   - 回合清理在合并之前：丢掉中间那个空回合之后两侧才可能变成相邻同角色；
 *   - `defaultMaxOutputTokens` 只动 L1，与会话无关，放最后。
 */
export const IR_REPAIR_KINDS = [
  /** 有 tool_result 却找不到对应的 tool_use：丢掉它（留着每个上游都 400）。 */
  "dropOrphanToolResult",
  /** 有 tool_use 却没有对应的 tool_result：补一条**显式说明结果不可信**的占位结果。 */
  "fillDanglingToolCall",
  /** tool_result 里一个 part 都没有：补一条说明「工具没有产出内容」的文本。 */
  "fillEmptyToolResult",
  /** 目标不支持图片：把 image part 换成描述它的文本占位符（像素不会到达模型）。 */
  "textualizeUnsupportedImage",
  /** 目标不支持文档：把 document part 换成描述它的文本占位符（正文不会到达模型）。 */
  "textualizeUnsupportedDocument",
  /** 空文本 part 与不含任何语义的回合：丢掉。 */
  "dropEmptyTurn",
  /** 相邻同角色回合：合并成一条（OpenAI 侧并行工具结果的常态形状）。 */
  "mergeAdjacentTurns",
  /** 客户端没给 `maxOutputTokens`，而目标必须/可以承载它：替客户端填一个默认值。 */
  "defaultMaxOutputTokens",
] as const;

export type IRRepairKind = (typeof IR_REPAIR_KINDS)[number];

// ═══════════════════════════════════════════════════════════════════════════
// 记录
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一次修复动作的留痕。
 *
 * `detail` 的写法有硬要求：说清楚**替客户端做了什么决定**，而不是「发生了什么」。
 * 「图片被丢了」是现象，「网关决定让模型看到一段描述而不是像素」才是决定。
 */
export interface IRRepairRecord {
  readonly kind: IRRepairKind;
  /** 精确 IR 路径，与 `IRCapabilityNeed.paths` / `IRLoss.path` 同一套写法。 */
  readonly path: string;
  readonly detail: string;
}

/** 每种修复的返回形状。`request` 在没有任何记录时**必须是入参那个对象本身**。 */
export interface IRRepairResult {
  readonly request: IRRequest;
  readonly applied: readonly IRRepairRecord[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 策略 —— typed 结构，不是布尔堆
// ═══════════════════════════════════════════════════════════════════════════

/** 没有旋钮的修复。写成 `{}` 即启用；留成 typed 空对象是为了以后加旋钮不破坏调用方。 */
export type IRRepairNoOptions = Readonly<Record<string, never>>;

/**
 * 「目标缺到什么程度才动手」。
 *
 *   capabilityAbsent        —— 只在 supports ∪ lossy 都没有时修（= 不修就会被准入拒掉）
 *   capabilityAbsentOrLossy —— 目标只能有损承载时也修（宁可给模型一句实话，也不要一份残缺的载体）
 */
export type IRRepairTrigger = "capabilityAbsent" | "capabilityAbsentOrLossy";

/**
 * 每种修复的选项形状。字段全是可选的：缺省值在 `IR_REPAIR_SPECS[kind].defaults` 里，
 * 那是唯一一份默认值。
 *
 * 占位文案支持 `{token}` 插值，可用 token 逐条写在字段注释里；未知 token 原样保留。
 */
export interface IRRepairOptionsByKind {
  readonly dropOrphanToolResult: IRRepairNoOptions;
  readonly fillDanglingToolCall: {
    /** 占位结果的正文。token：`{callId}` `{toolName}`。 */
    readonly placeholderText?: string;
  };
  readonly fillEmptyToolResult: {
    /** 空结果的正文。token：`{callId}` `{status}`。 */
    readonly placeholderText?: string;
  };
  readonly textualizeUnsupportedImage: {
    /** 替代图片的正文。token：`{mediaType}` `{bytes}`。 */
    readonly placeholderText?: string;
    readonly trigger?: IRRepairTrigger;
  };
  readonly textualizeUnsupportedDocument: {
    /** 替代文档的正文。token：`{mediaType}` `{bytes}` `{title}`。 */
    readonly placeholderText?: string;
    readonly trigger?: IRRepairTrigger;
  };
  readonly dropEmptyTurn: IRRepairNoOptions;
  readonly mergeAdjacentTurns: IRRepairNoOptions;
  readonly defaultMaxOutputTokens: {
    /** 替客户端填进 `$.intent.stopping.maxOutputTokens` 的值，`source` 恒为 gateway-default。 */
    readonly tokens?: number;
  };
}

/**
 * 修复策略。**键存在 = 启用**，键缺席 = 不修。
 *
 * 没有 `enabled: boolean` 这一层：一个布尔加一份选项等于两个真值来源，
 * 迟早出现「配了文案却没生效」。
 */
export type IRRepairPolicy = { readonly [K in IRRepairKind]?: IRRepairOptionsByKind[K] };

/** 默认策略：什么都不修。任何修复都必须是调用方显式写出来的选择。 */
export const IR_REPAIR_POLICY_NONE: IRRepairPolicy = Object.freeze({});

// ═══════════════════════════════════════════════════════════════════════════
// 规格表
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 目标能力闸门。**必要条件**，不是充分条件：闸门不通过时执行器直接跳过这条修复，
 * 通过之后具体改哪些 part 仍由实现按站点判断（如 tool result 里的图片看 `toolResultImage`，
 * 顶层图片看 `image`）。
 *
 * 写成判别联合而不是 `capabilities: IRCapability[]`，是因为两个方向都真实存在：
 * 模态降级是「目标**没有**这个能力才修」，而补 max_tokens 恰好相反 ——
 * 目标连 `maxOutputTokens` 都不认时替它填一个，只会凭空造出一条准入过不去的需求。
 */
export type IRRepairCapabilityGate =
  | { readonly kind: "targetIndependent" }
  | { readonly kind: "repairWhenMissing"; readonly capabilities: readonly IRCapability[] }
  | { readonly kind: "repairWhenPresent"; readonly capabilities: readonly IRCapability[] };

export interface IRRepairInput<K extends IRRepairKind> {
  readonly request: IRRequest;
  readonly profile: IREgressProfile;
  /** 已与 `defaults` 合并过，字段全部就位。 */
  readonly options: Required<IRRepairOptionsByKind[K]>;
}

export interface IRRepairSpec<K extends IRRepairKind> {
  readonly kind: K;
  /** 这条修复落成 `IRLoss` 时的类别。唯一一份，调用方不许各猜各的。 */
  readonly lossKind: IRLoss["kind"];
  readonly capabilityGate: IRRepairCapabilityGate;
  /** 唯一一份默认值。 */
  readonly defaults: Required<IRRepairOptionsByKind[K]>;
  readonly apply: (input: IRRepairInput<K>) => IRRepairResult;
}

/**
 * 种类 → 规格。映射类型是本层的**枚举完整性机制**：
 * 漏一种、多一种、拼错一种，`IR_REPAIR_SPECS` 的赋值当场编译失败。
 */
export type IRRepairSpecTable = { readonly [K in IRRepairKind]: IRRepairSpec<K> };
