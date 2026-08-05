/**
 * 规格表 —— 种类 → { 闸门, 默认值, 实现, loss 类别 }。
 *
 * 这是本层「重复分派是数据」的落点：八种修复的差异全部收敛成这张表的八行，
 * 执行器只有一个（`src/repair/index.ts` 的 `runRepair`），没有第二处 switch。
 *
 * 枚举完整性靠类型强制，不靠人记：
 *   - `IRRepairSpecTable` 是以 `IRRepairKind` 为键的映射类型 → 漏一种当场编译失败；
 *   - 对象字面量的多余属性检查 → 多一种/拼错一种当场编译失败；
 *   - 每行的 `kind` 字段被 `IRRepairSpec<K>` 绑死在键上 → 张冠李戴当场编译失败；
 *   - `defaults` 是 `Required<IRRepairOptionsByKind[K]>` → 新增一个旋钮而不给默认值，编译失败。
 */
import type { IRRepairSpecTable } from "./contract.ts";
import {
  dropEmptyTurns, dropOrphanToolResults, fillDanglingToolCalls, fillDefaultMaxOutputTokens,
  fillEmptyToolResults, mergeAdjacentTurns, raiseMaxOutputTokens,
  textualizeUnsupportedDocuments, textualizeUnsupportedImages,
} from "./repairs.ts";

/**
 * 默认占位文案。每一句都要经得起同一个问题：**模型读完这句话会不会做出错误假设？**
 *
 * 反面教材是「假装工具返回了空字符串」—— agent 会当成命令执行成功且无输出，
 * 接着往下走一整条错误的推理链。所以这几句一律先自报是网关插的，再说清结果不可信。
 */
const DEFAULT_DANGLING_TOOL_CALL_TEXT =
  "[gateway] No result was recorded for tool call {toolName} (id {callId}). "
  + "The outcome is UNKNOWN: it may have succeeded, failed, or never run. "
  + "Do not assume it produced no output, and re-run or verify before relying on its effect.";

const DEFAULT_EMPTY_TOOL_RESULT_TEXT =
  "[gateway] Tool call {callId} returned no content (status {status}). "
  + "Emptiness is what the client reported, not a gateway failure.";

const DEFAULT_IMAGE_TEXT =
  "[gateway] An image ({mediaType}, {bytes} bytes) was removed here because the upstream model cannot receive images. "
  + "You have NOT seen this image; do not describe or reason about its contents.";

const DEFAULT_DOCUMENT_TEXT =
  "[gateway] A document titled \"{title}\" ({mediaType}, {bytes} bytes) was removed here because the upstream model "
  + "cannot receive documents. You have NOT read it; do not quote or summarise its contents.";

/**
 * Anthropic Messages 强制要求 `max_tokens`，取 4096 与出口现行行为一致。
 * 这个数字是**策略**：调用方按自己的模型与成本预算改，本层不替它决定得更聪明。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * 抬高客户端上限时的落点。语料实测：CloudCode 对 `effort:'high'` 折出 thinkingBudget=10000，
 * 加上 4096 的可见正文下限，下限是 14096 —— 22 条真实请求栽在这个组合上（客户端给的是
 * 32 / 256 / 1024）。16384 是能盖住这批实证、又是 2 的整数次幂的最小取值。
 *
 * 它同样是**策略**：跑 xhigh/max 档（预算 24000 / 32768）的调用方必须自己调高，
 * 本层不去复刻各家出口的档位表来「算得更聪明」——那会变成第二份会漂移的认知。
 */
const MINIMUM_RAISED_OUTPUT_TOKENS = 16_384;

/**
 * 客户端明说了思考预算时，预算之上再留给可见正文的额度。
 * 4096 取自 CloudCode 出口对同一件事的判据（`MIN_VISIBLE_TOKENS`）—— 那不是巧合：
 * 「思考吃光额度、上游回 200 空正文」这个故障是同一个，两边给出的下限自然是同一个数量级。
 */
const VISIBLE_OUTPUT_TOKENS = 4096;

export const IR_REPAIR_SPECS: IRRepairSpecTable = {
  dropOrphanToolResult: {
    kind: "dropOrphanToolResult",
    lossKind: "dropped",
    capabilityGate: { kind: "targetIndependent" },
    defaults: {},
    apply: ({ request }) => dropOrphanToolResults(request),
  },

  fillDanglingToolCall: {
    kind: "fillDanglingToolCall",
    lossKind: "substituted",
    capabilityGate: { kind: "targetIndependent" },
    defaults: { placeholderText: DEFAULT_DANGLING_TOOL_CALL_TEXT },
    apply: ({ request, options }) => fillDanglingToolCalls(request, options),
  },

  fillEmptyToolResult: {
    kind: "fillEmptyToolResult",
    lossKind: "substituted",
    capabilityGate: { kind: "targetIndependent" },
    defaults: { placeholderText: DEFAULT_EMPTY_TOOL_RESULT_TEXT },
    apply: ({ request, options }) => fillEmptyToolResults(request, options),
  },

  textualizeUnsupportedImage: {
    kind: "textualizeUnsupportedImage",
    lossKind: "degraded",
    // 两个位置两个能力：顶层图片看 image，tool result 里的图片还要看 toolResultImage。
    capabilityGate: { kind: "repairWhenMissing", capabilities: ["image", "toolResultImage"] },
    defaults: { placeholderText: DEFAULT_IMAGE_TEXT, trigger: "capabilityAbsent" },
    apply: ({ request, profile, options }) => textualizeUnsupportedImages(request, profile, options),
  },

  textualizeUnsupportedDocument: {
    kind: "textualizeUnsupportedDocument",
    lossKind: "degraded",
    capabilityGate: { kind: "repairWhenMissing", capabilities: ["document"] },
    defaults: { placeholderText: DEFAULT_DOCUMENT_TEXT, trigger: "capabilityAbsent" },
    apply: ({ request, profile, options }) => textualizeUnsupportedDocuments(request, profile, options),
  },

  dropEmptyTurn: {
    kind: "dropEmptyTurn",
    lossKind: "dropped",
    capabilityGate: { kind: "targetIndependent" },
    defaults: {},
    apply: ({ request }) => dropEmptyTurns(request),
  },

  mergeAdjacentTurns: {
    kind: "mergeAdjacentTurns",
    lossKind: "degraded",
    capabilityGate: { kind: "targetIndependent" },
    defaults: {},
    apply: ({ request }) => mergeAdjacentTurns(request),
  },

  defaultMaxOutputTokens: {
    kind: "defaultMaxOutputTokens",
    lossKind: "substituted",
    // 闸门问的是「目标**要求**它吗」，不是「目标认识它吗」：只是接受它的上游被填了值，
    // 等于凭空造出一条它本来没有的约束（DEFECT-10，18/807 条真实请求因此变 422）。
    capabilityGate: { kind: "repairWhenMandatory", fields: ["maxOutputTokens"] },
    defaults: { tokens: DEFAULT_MAX_OUTPUT_TOKENS },
    apply: ({ request, options }) => fillDefaultMaxOutputTokens(request, options),
  },

  raiseMaxOutputTokens: {
    kind: "raiseMaxOutputTokens",
    lossKind: "substituted",
    // 与目标能力无关：「上限低于自己的思考预算」在任何把思考算进这个上限的目标上都无解
    // （CloudCode 实测 200 空正文；Anthropic 的 budget_tokens < max_tokens 是硬校验）。
    capabilityGate: { kind: "targetIndependent" },
    defaults: {
      minimumTokens: MINIMUM_RAISED_OUTPUT_TOKENS,
      visibleOutputTokens: VISIBLE_OUTPUT_TOKENS,
    },
    apply: ({ request, options }) => raiseMaxOutputTokens(request, options),
  },
};
