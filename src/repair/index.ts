/**
 * Repair —— **可选**的修复层：把 Core 里那些「网关替客户端做决定」的隐式降级
 * 收成一个可穷举的封闭集，由调用方显式 compose。
 *
 * Core 的分工不变：表达不了就带精确 IR 路径拒绝，绝不发明内容。这一层的存在意义正是
 * 让**原本会被 `checkUpstreamSupport` 拒掉的请求**在调用方明确同意某种降级之后通过：
 *
 * ```ts
 * const policy: IRRepairPolicy = {
 *   dropOrphanToolResult: {},
 *   fillDanglingToolCall: {},
 *   textualizeUnsupportedDocument: { placeholderText: "[文档已省略：{title}]" },
 *   defaultMaxOutputTokens: { tokens: 8192 },
 * };
 * const { request, applied } = repairIRRequest(clientRequest, egress.profile, policy);
 * const check = checkUpstreamSupport(request, egress.profile);   // 现在可能过了
 * const losses = describeRepairsAsLosses(applied, egress.profile.provider);
 * ```
 *
 * 不传策略（或传 `IR_REPAIR_POLICY_NONE`）时 `request` 是**入参那个对象本身**：
 * 确定性是默认值，修复是显式选择。
 */
import { checkUpstreamSupport } from "../ir/admission.ts";
import type { IREgressProfile, IRLoss, IRRequest } from "../ir/types.ts";
import {
  IR_REPAIR_KINDS,
  type IRRepairCapabilityGate, type IRRepairKind, type IRRepairOptionsByKind, type IRRepairPolicy,
  type IRRepairRecord, type IRRepairResult,
} from "./contract.ts";
import { IR_REPAIR_SPECS } from "./specs.ts";

export {
  IR_REPAIR_KINDS, IR_REPAIR_POLICY_NONE,
  type IRRepairCapabilityGate, type IRRepairInput, type IRRepairKind, type IRRepairNoOptions,
  type IRRepairOptionsByKind, type IRRepairPolicy, type IRRepairRecord, type IRRepairResult,
  type IRRepairSpec, type IRRepairSpecTable, type IRRepairTrigger,
} from "./contract.ts";
export { IR_REPAIR_SPECS } from "./specs.ts";
/** 单条修复也是公开契约：调用方可以只用其中一条，拿到的 IR 同样自洽（`requires` 已重推）。 */
export {
  dropEmptyTurns, dropOrphanToolResults, fillDanglingToolCalls, fillDefaultMaxOutputTokens,
  fillEmptyToolResults, mergeAdjacentTurns, textualizeUnsupportedDocuments, textualizeUnsupportedImages,
} from "./repairs.ts";

/**
 * 闸门裁决。**必要条件**：不满足就连跑都不跑；满足了具体改哪些 part 仍由实现按站点判断。
 *
 * `repairWhenMissing` 取「不在 supports」这个最宽的判据（lossy 也算缺），
 * 是否真的对 lossy 动手由每条修复自己的 `trigger` 选项收窄 —— 闸门不能比实现更严，
 * 否则会出现「选项开了却没生效」。
 */
function isGateSatisfied(gate: IRRepairCapabilityGate, profile: IREgressProfile): boolean {
  switch (gate.kind) {
    case "targetIndependent":
      return true;
    case "repairWhenMissing":
      return gate.capabilities.some((capability) => !profile.supports.has(capability));
    case "repairWhenPresent":
      return gate.capabilities.every(
        (capability) => profile.supports.has(capability) || profile.lossy.has(capability));
  }
}

/**
 * 唯一的通用执行器。种类是类型参数，`policy[kind]` / `IR_REPAIR_SPECS[kind]` /
 * `defaults` 三者的关联由编译器保证 —— 这里不存在也不允许存在任何 `switch (kind)`。
 */
function runRepair<K extends IRRepairKind>(
  kind: K, request: IRRequest, profile: IREgressProfile, policy: IRRepairPolicy,
): IRRepairResult {
  const entry = policy[kind];
  // 键缺席 = 不修。没有 enabled 布尔，也就没有「配了却没生效」这种状态。
  if (entry === undefined) return { request, applied: [] };
  const spec = IR_REPAIR_SPECS[kind];
  if (!isGateSatisfied(spec.capabilityGate, profile)) return { request, applied: [] };
  const options: Required<IRRepairOptionsByKind[K]> = { ...spec.defaults, ...entry };
  return spec.apply({ request, profile, options });
}

/**
 * 按 `IR_REPAIR_KINDS` 的声明顺序跑一遍策略里启用的修复。
 *
 * 顺序取自枚举本身而不是策略对象的键序：策略是调用方随手写的字面量，
 * 让流水线行为依赖它的书写顺序等于把「先摘孤儿再补悬空」这类真实依赖交给运气。
 */
export function repairIRRequest(
  request: IRRequest, profile: IREgressProfile, policy: IRRepairPolicy,
): IRRepairResult {
  let current = request;
  const applied: IRRepairRecord[] = [];
  for (const kind of IR_REPAIR_KINDS) {
    const outcome = runRepair(kind, current, profile, policy);
    current = outcome.request;
    applied.push(...outcome.applied);
  }
  return { request: current, applied };
}

/**
 * 修复记录 → `IRLoss`。类别取自规格表，调用方不许各猜各的。
 *
 * `stage` 恒为 `egress`：修复发生在准入之前、出口之上，是「为了这一家上游而做的决定」，
 * 换一家上游结论就可能不同。
 */
export function describeRepairsAsLosses(
  applied: readonly IRRepairRecord[], provider: string,
): IRLoss[] {
  return applied.map((record) => ({
    stage: "egress",
    provider,
    path: record.path,
    kind: IR_REPAIR_SPECS[record.kind].lossKind,
    detail: record.detail,
  }));
}

/**
 * 「修一次能不能过准入」的一步式回答。
 *
 * 提供它是因为这层的价值判据只有一个：**原本被拒的请求变得可通过**。把「修完再裁决」
 * 写成一个函数，调用方就不会漏掉「修完必须重新裁决」这一步 ——
 * 修复会改变 `requires`，拿旧裁决结果做决定必错。
 */
export function repairForAdmission(
  request: IRRequest, profile: IREgressProfile, policy: IRRepairPolicy,
): IRRepairResult & { readonly admission: ReturnType<typeof checkUpstreamSupport> } {
  const outcome = repairIRRequest(request, profile, policy);
  return { ...outcome, admission: checkUpstreamSupport(outcome.request, profile) };
}
