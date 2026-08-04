/**
 * 「这条 problem 该开哪条 repair」—— 拒绝信息里最贵的那一句。
 *
 * **这张表必须住在 server 层**，不能下沉进 Core。Core（`src/ir`、`src/egress`）的契约是
 * 「目标 wire 表达不了就带精确路径拒绝」，它对 repair 层的存在一无所知也不该知道：
 * repair 是调用方的策略，换一个调用方（例如一个只想看 422、自己决定怎么改请求的 SDK）
 * 根本不会 compose 它。把 `IRRepairKind` 写进 `IRBuildProblem` 会让 Core 依赖策略层，
 * 两条轴就粘死了。server 是**两边共同的调用方**，映射天然属于这里。
 *
 * 穷举靠两个机制，不靠人记得：
 *   1. `Record<IRBuildProblemKind, …>` 是以 Core 的常量数组派生出的联合为键的映射类型 ——
 *      Core 新增一种 problem kind，这一行赋值当场编译失败；
 *   2. 值的元素类型是 `IRRepairKind` —— repair 层改名/删种，这里同样当场失败。
 *   3. `test/gateway_config.test.ts` 再用 `IR_BUILD_PROBLEM_KINDS` 与 `IR_REPAIR_KINDS`
 *      在运行时枚举两侧核对，兜住「键写全了但值指向一条不存在的修复」之外的那点空隙。
 *
 * 映射是**候选集**不是单值：一种 problem kind 可以由不同站点抛出（`requiredFieldMissing`
 * 既来自缺 max_tokens，也来自空工具结果），对应的修复也就不止一条。给全候选比给一条
 * 「最可能」的更诚实 —— 调用方看得到自己那条 path 属于哪一类。
 */
import { type IRBuildProblem, type IRBuildProblemKind } from "../ir/types.ts";
import { type IRRepairKind } from "../repair/index.ts";

/** 修复种类由哪个环境变量打开。写进拒绝信息，让调用方不必翻文档。 */
export const REPAIR_KINDS_VARIABLE = "AGENT_IR_REQUEST_REPAIR_KINDS";

/**
 * problem kind → 能修它的 repair kind 候选。
 *
 * **空数组是合法且有信息量的取值**：它说的是「repair 层现在没有一条能修这类问题」，
 * 而不是「忘了填」。把没有答案的格子填一条最接近的修复，比留空贵得多 ——
 * 调用方会按建议开一条修复，重跑，拿到一模一样的 422。
 *
 * 反方向**不要求全覆盖**：`dropEmptyTurn` / `mergeAdjacentTurns` 修的是「准入过不去」
 * 与「相邻同角色回合」这类形状问题，它们不由任何 `IRBuildProblem` 报出来，所以不在这张表里。
 * 测试会把「没被任何 problem 引用的修复」枚举出来，让这个事实保持可见而不是被忘掉。
 */
export const REPAIRS_FOR_PROBLEM_KIND: Readonly<Record<IRBuildProblemKind, readonly IRRepairKind[]>> = {
  /**
   * 目标 wire 强制要求而 IR 里没有。两个真实站点：
   * 缺 `max_tokens`（anthropic / gemini）→ `defaultMaxOutputTokens`；
   * 工具结果编不出任何内容（chat / responses / gemini）→ `fillEmptyToolResult`。
   */
  requiredFieldMissing: ["defaultMaxOutputTokens", "fillEmptyToolResult"],
  /**
   * 值在、只是装不下（CloudCode 的 `maxOutputTokens` 要容得下 thinkingBudget + 可见正文）。
   *
   * **当前一条修复都没有**，这是事实不是遗漏：`defaultMaxOutputTokens` 只在客户端**没给**
   * 的时候补一个值，它不会去抬高客户端明确说出口的上限 —— 抬高等于替客户端改掉他的原话，
   * 那是另一条还没有人登记过的修复。留空，让拒绝信息老实说「没有能修它的」。
   */
  unsatisfiableValue: [],
  /** 有 tool_use 没有对应结果。 */
  danglingToolCall: ["fillDanglingToolCall"],
  /** 有 tool_result 找不到对应调用。 */
  orphanToolResult: ["dropOrphanToolResult"],
  /** 某个 part 在目标 wire 里没有位置：图片/文档可以降级成文本占位符。 */
  unrepresentablePart: ["textualizeUnsupportedImage", "textualizeUnsupportedDocument"],
};

/**
 * 一条 problem 的可执行描述：**是什么、在哪、开哪条能修**。
 *
 * 已经开着的修复不再建议 —— 「开了还报同一个 problem」说明这条 path 不归它管，
 * 再劝一遍只会把人引到错误的方向上。三种措辞对应三种不同的处境，不合并：
 *   有候选没开     → 说清楚开哪条；
 *   候选全开着了   → 说清楚「已经开了，它管不到这条」；
 *   一条候选都没有 → 说清楚「repair 层没有能修它的」，别让人白开一轮。
 */
export function describeProblemWithRepairAdvice(
  problem: IRBuildProblem, enabledRepairs: ReadonlySet<IRRepairKind>,
): string {
  const known = REPAIRS_FOR_PROBLEM_KIND[problem.kind];
  const candidates = known.filter((kind) => !enabledRepairs.has(kind));
  const advice = candidates.length > 0
    ? `enable ${REPAIR_KINDS_VARIABLE}=${candidates.join(",")} to let the gateway repair it`
    : known.length === 0
      ? "no repair kind covers this problem; the request itself has to change"
      : `repair ${known.join(",")} is already enabled and does not cover this path`;
  return `${problem.kind} at ${problem.path}: ${problem.detail} — ${advice}`;
}
