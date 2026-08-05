/**
 * 八种修复的实现。每一个都是纯函数：入参 `IRRequest` 一个字段都不改，
 * 没有任何记录时**原样返回入参那个对象**（调用方可以靠引用相等判断「没动过」）。
 *
 * 所有实现共用三样东西，不许各写各的：
 *   `repaired()`         —— 唯一的收尾：有记录才建新对象，并**重新推导 `requires`**
 *   `mapConversationParts()` —— 唯一的 part 树遍历（system + turns + tool result 内层）
 *   `renderPlaceholder()`    —— 唯一的占位文案插值
 *
 * `requires` 必须在每条修复内部重新推导，不能留给 compose 收尾：单独调用一条修复的人
 * 拿到的也必须是自洽的 IR，否则「修好了但准入还是拒」这种鬼故事迟早发生。
 */
import { deriveCapabilityNeeds } from "../ir/capabilities.ts";
import { defaultValue } from "../ir/types.ts";
import type {
  IRCapability, IRConversation, IROutboxProfile, IRPart, IRRequest, IRToolRef, IRTurn,
} from "../ir/types.ts";
import type { IRRepairOptionsByKind, IRRepairRecord, IRRepairResult, IRRepairTrigger } from "./contract.ts";

type OptionsOf<K extends keyof IRRepairOptionsByKind> = Required<IRRepairOptionsByKind[K]>;

// ── 共用原语 ────────────────────────────────────────────────────────────────

/**
 * 唯一收尾。没有记录 = 没修 = 原样返回；修了就重新推导 `requires`（L2 由 L0/L1 派生，
 * 手动打补丁必然与 `deriveCapabilityNeeds` 漂移）。
 */
function repaired(original: IRRequest, next: IRRequest, applied: readonly IRRepairRecord[]): IRRepairResult {
  if (applied.length === 0) return { request: original, applied: [] };
  return { request: { ...next, requires: deriveCapabilityNeeds(next) }, applied };
}

const turnPath = (turnIndex: number): string => `$.conversation.turns[${turnIndex}]`;
const turnPartPath = (turnIndex: number, partIndex: number): string => `${turnPath(turnIndex)}.parts[${partIndex}]`;

/** 分组是结构不是前缀；这里只为写进人类可读的 detail，不参与任何关联。 */
const describeToolRef = (ref: IRToolRef): string => (ref.group === null ? ref.name : `${ref.group}/${ref.name}`);

/** `{token}` 插值。未知 token 原样保留 —— 悄悄换成空串会让配错的文案看起来像配对了。 */
function renderPlaceholder(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole: string, token: string) => values[token] ?? whole);
}

/**
 * 目标是否「缺」这个能力。`trigger` 决定 lossy 算不算缺 —— 这是策略，
 * 所以由调用方的选项说了算，不在这里写死。
 */
function lacksCapability(profile: IROutboxProfile, capability: IRCapability, trigger: IRRepairTrigger): boolean {
  if (profile.supports.has(capability)) return false;
  return trigger === "capabilityAbsentOrLossy" || !profile.lossy.has(capability);
}

interface PartSite {
  readonly path: string;
  /** 该 part 位于某条 tool result 内部。语料里 94 条工具结果含图片，这个位置的能力需求不同。 */
  readonly insideToolResult: boolean;
}

/** 返回同一个引用 = 这个 part 没动。 */
type PartMapper = (part: IRPart, site: PartSite) => IRPart;

function mapPartDeep(part: IRPart, site: PartSite, mapper: PartMapper): IRPart {
  const mapped = mapper(part, site);
  // mapper 已经对这个 part 表过态就不再下钻：它给出的形态是最终形态。
  if (mapped !== part) return mapped;
  if (part.kind !== "toolResult") return part;
  const inner = mapPartList(part.result.parts, `${site.path}.result.parts`, true, mapper);
  if (inner === part.result.parts) return part;
  return { ...part, result: { ...part.result, parts: inner } };
}

function mapPartList(
  parts: readonly IRPart[], basePath: string, insideToolResult: boolean, mapper: PartMapper,
): readonly IRPart[] {
  const mapped = parts.map((part, index) =>
    mapPartDeep(part, { path: `${basePath}[${index}]`, insideToolResult }, mapper));
  return mapped.every((part, index) => part === parts[index]) ? parts : mapped;
}

/** 唯一的 part 树遍历入口：system 与 turns 都走这里，任何修复都不该自己再写一遍下钻。 */
function mapConversationParts(conversation: IRConversation, mapper: PartMapper): IRConversation {
  const system = mapPartList(conversation.system, "$.conversation.system", false, mapper);
  const turns = conversation.turns.map((turn, index) => {
    const parts = mapPartList(turn.parts, `${turnPath(index)}.parts`, false, mapper);
    return parts === turn.parts ? turn : { role: turn.role, parts };
  });
  const turnsChanged = turns.some((turn, index) => turn !== conversation.turns[index]);
  if (system === conversation.system && !turnsChanged) return conversation;
  return { ...conversation, system, turns };
}

const withConversation = (request: IRRequest, conversation: IRConversation): IRRequest =>
  ({ ...request, conversation });

const isEmptyText = (part: IRPart): boolean =>
  part.kind === "text" && part.text.length === 0 && part.cacheBreakpoint === undefined;

// ── dropOrphanToolResult ────────────────────────────────────────────────────

/**
 * 丢掉找不到对应 tool_use 的 tool_result。
 *
 * 这是**策略**而不是编译事实：还有别的处置方式（把它降级成普通文本讲给模型听、
 * 或者直接 422 让客户端修历史）。默认不做，做了就留痕。
 */
export function dropOrphanToolResults(request: IRRequest): IRRepairResult {
  const { conversation } = request;
  const callIds = new Set<string>();
  for (const turn of conversation.turns) {
    for (const part of turn.parts) if (part.kind === "toolCall") callIds.add(part.call.id);
  }

  const records: IRRepairRecord[] = [];
  const turns = conversation.turns.map((turn, turnIndex) => {
    const kept = turn.parts.filter((part, partIndex) => {
      if (part.kind !== "toolResult" || callIds.has(part.result.callId)) return true;
      records.push({
        kind: "dropOrphanToolResult",
        path: turnPartPath(turnIndex, partIndex),
        detail:
          `gateway dropped the tool result for call '${part.result.callId}': the conversation declares no matching ` +
          `tool call, so the model will never be told this output existed`,
      });
      return false;
    });
    return kept.length === turn.parts.length ? turn : { role: turn.role, parts: kept };
  });

  return repaired(request, withConversation(request, { ...conversation, turns }), records);
}

// ── fillDanglingToolCall ────────────────────────────────────────────────────

/**
 * 给没有结果的 tool_use 补一条占位结果，插在**紧随其后的 user 回合最前面**
 * （没有就新建一条 user 回合）。IR 内部靠 id 关联，但位置约束是下游 outbox 的现实，
 * 补在正确的位置能让任何 outbox 都不必二次搬运。
 *
 * 措辞是这条修复的**全部风险所在**：假装工具返回了空内容，agent 会当成「命令执行成功、
 * 无输出」继续往下走。默认文案必须把「结果未知、不要假定成功」说死。
 */
export function fillDanglingToolCalls(
  request: IRRequest, options: OptionsOf<"fillDanglingToolCall">,
): IRRepairResult {
  const { conversation } = request;
  const answered = new Set<string>();
  for (const turn of conversation.turns) {
    for (const part of turn.parts) if (part.kind === "toolResult") answered.add(part.result.callId);
  }

  const records: IRRepairRecord[] = [];
  const turns: IRTurn[] = [];
  let pending: readonly IRPart[] = [];

  conversation.turns.forEach((turn, turnIndex) => {
    if (pending.length === 0) turns.push(turn);
    else if (turn.role === "user") turns.push({ role: "user", parts: [...pending, ...turn.parts] });
    else { turns.push({ role: "user", parts: pending }); turns.push(turn); }
    pending = [];

    if (turn.role !== "assistant") return;
    pending = turn.parts.flatMap<IRPart>((part, partIndex) => {
      if (part.kind !== "toolCall" || answered.has(part.call.id)) return [];
      answered.add(part.call.id);
      const toolName = describeToolRef(part.call.toolRef);
      records.push({
        kind: "fillDanglingToolCall",
        path: turnPartPath(turnIndex, partIndex),
        detail:
          `gateway invented a result for tool call '${toolName}' (${part.call.id}) that the client never reported; ` +
          `the model is told the outcome is unknown rather than being shown an empty success`,
      });
      return [{
        kind: "toolResult",
        result: {
          callId: part.call.id,
          parts: [{
            kind: "text",
            text: renderPlaceholder(options.placeholderText, { callId: part.call.id, toolName }),
          }],
          status: "missing",
        },
      }];
    });
  });
  if (pending.length > 0) turns.push({ role: "user", parts: pending });

  return repaired(request, withConversation(request, { ...conversation, turns }), records);
}

// ── fillEmptyToolResult ─────────────────────────────────────────────────────

/**
 * 一个 part 都没有（或只有空文本）的 tool_result 补一句正文。
 *
 * 上游普遍拒收空内容块，但「补什么」是决定：补 `""` 等于告诉模型工具跑成功了且没输出，
 * 补一句明说「没有产出内容」才是实话。
 */
export function fillEmptyToolResults(
  request: IRRequest, options: OptionsOf<"fillEmptyToolResult">,
): IRRepairResult {
  const records: IRRepairRecord[] = [];
  const conversation = mapConversationParts(request.conversation, (part, site) => {
    if (part.kind !== "toolResult") return part;
    if (part.result.parts.some((child) => !isEmptyText(child))) return part;
    records.push({
      kind: "fillEmptyToolResult",
      path: site.path,
      detail:
        `gateway chose the wording for the empty result of call '${part.result.callId}' (status ${part.result.status}); ` +
        `an empty content block is rejected upstream and a bare '' would read as a successful silent command`,
    });
    return {
      ...part,
      result: {
        ...part.result,
        parts: [{
          kind: "text",
          text: renderPlaceholder(options.placeholderText, {
            callId: part.result.callId, status: part.result.status,
          }),
        }],
      },
    };
  });

  return repaired(request, withConversation(request, conversation), records);
}

// ── textualizeUnsupportedImage / textualizeUnsupportedDocument ──────────────

/**
 * 目标载不动图片时，把 image part 换成一句描述它的文本。
 *
 * 站点敏感：tool result 里的图片与顶层图片是**两个能力**（`toolResultImage` / `image`），
 * 实测 openai_chat_completions 支持后者却完全不支持前者。判据与 `deriveCapabilityNeeds`
 * 对这两个位置的推导保持同构，否则会出现「修完了准入还是拒」。
 *
 * 这是本层最该被质疑的一条：像素没了，模型看到的是一句转述。仓库里 chat 出口的注释说得对 ——
 * 「该换一家上游，不该假装送到了」。所以它默认关闭，只有调用方明确认为「有总比 422 好」时才开。
 */
export function textualizeUnsupportedImages(
  request: IRRequest, profile: IROutboxProfile, options: OptionsOf<"textualizeUnsupportedImage">,
): IRRepairResult {
  const records: IRRepairRecord[] = [];
  const conversation = mapConversationParts(request.conversation, (part, site) => {
    if (part.kind !== "image") return part;
    const lacks = lacksCapability(profile, "image", options.trigger)
      || (site.insideToolResult && lacksCapability(profile, "toolResultImage", options.trigger));
    if (!lacks) return part;
    records.push({
      kind: "textualizeUnsupportedImage",
      path: site.path,
      detail:
        `gateway decided the selected outbox should see a text description instead of this ${part.media.mediaType} ` +
        `image; the pixels never reach the model`,
    });
    return {
      kind: "text",
      text: renderPlaceholder(options.placeholderText, {
        mediaType: part.media.mediaType,
        bytes: part.media.bytes === undefined ? "unknown" : String(part.media.bytes),
      }),
      ...(part.cacheBreakpoint === undefined ? {} : { cacheBreakpoint: part.cacheBreakpoint }),
    };
  });

  return repaired(request, withConversation(request, conversation), records);
}

/** 与图片同构，判据只看 `document` —— 文档在 tool result 里也不另需一个能力。 */
export function textualizeUnsupportedDocuments(
  request: IRRequest, profile: IROutboxProfile, options: OptionsOf<"textualizeUnsupportedDocument">,
): IRRepairResult {
  const records: IRRepairRecord[] = [];
  const conversation = mapConversationParts(request.conversation, (part, site) => {
    if (part.kind !== "document") return part;
    if (!lacksCapability(profile, "document", options.trigger)) return part;
    records.push({
      kind: "textualizeUnsupportedDocument",
      path: site.path,
      detail:
        `gateway decided the selected outbox should see a text description instead of this ${part.media.mediaType} ` +
        `document; its body never reaches the model`,
    });
    return {
      kind: "text",
      text: renderPlaceholder(options.placeholderText, {
        mediaType: part.media.mediaType,
        bytes: part.media.bytes === undefined ? "unknown" : String(part.media.bytes),
        title: part.title ?? "untitled",
      }),
      ...(part.cacheBreakpoint === undefined ? {} : { cacheBreakpoint: part.cacheBreakpoint }),
    };
  });

  return repaired(request, withConversation(request, conversation), records);
}

// ── dropEmptyTurn ───────────────────────────────────────────────────────────

/**
 * 丢掉空文本 part 与由此变空的回合。路径用**入参的原始下标**，调用方才能在自己发来的
 * 请求里找到位置。
 *
 * 只丢不合并：合并是另一个决定，见 `mergeAdjacentTurns`。
 */
export function dropEmptyTurns(request: IRRequest): IRRepairResult {
  const { conversation } = request;
  const records: IRRepairRecord[] = [];
  const turns: IRTurn[] = [];

  conversation.turns.forEach((turn, turnIndex) => {
    const kept = turn.parts.filter((part) => !isEmptyText(part));
    if (kept.length === 0) {
      records.push({
        kind: "dropEmptyTurn",
        path: turnPath(turnIndex),
        detail:
          `gateway removed an empty ${turn.role} turn; it carries no semantics and every upstream rejects it, ` +
          `but the turn count the client sent no longer matches what the model sees`,
      });
      return;
    }
    if (kept.length !== turn.parts.length) {
      turn.parts.forEach((part, partIndex) => {
        if (!isEmptyText(part)) return;
        records.push({
          kind: "dropEmptyTurn",
          path: turnPartPath(turnIndex, partIndex),
          detail: `gateway removed an empty text part from this ${turn.role} turn`,
        });
      });
    }
    turns.push(kept.length === turn.parts.length ? turn : { role: turn.role, parts: kept });
  });

  return repaired(request, withConversation(request, { ...conversation, turns }), records);
}

// ── mergeAdjacentTurns ──────────────────────────────────────────────────────

/**
 * 合并相邻同角色回合。OpenAI 侧一次并行工具调用会产生连续多条 `role:'tool'` 消息
 * （语料 2355 条 tool 消息 / 202 次并行），不合并就会在 lower 回 Anthropic 时
 * 变成多条 user 消息，被判成「漏了结果」。
 */
export function mergeAdjacentTurns(request: IRRequest): IRRepairResult {
  const { conversation } = request;
  const records: IRRepairRecord[] = [];
  const turns: IRTurn[] = [];

  conversation.turns.forEach((turn, turnIndex) => {
    const previous = turns[turns.length - 1];
    if (previous === undefined || previous.role !== turn.role) { turns.push(turn); return; }
    turns[turns.length - 1] = { role: previous.role, parts: [...previous.parts, ...turn.parts] };
    records.push({
      kind: "mergeAdjacentTurns",
      path: turnPath(turnIndex),
      detail:
        `gateway folded this ${turn.role} turn into the preceding ${turn.role} turn; the parts survive in order ` +
        `but the client's turn boundary is gone`,
    });
  });

  return repaired(request, withConversation(request, { ...conversation, turns }), records);
}

// ── defaultMaxOutputTokens ──────────────────────────────────────────────────

/**
 * 客户端没给上限时替它填一个。**只在目标强制要求 `maxOutputTokens` 时才该调用**
 * （由规格表的 `repairWhenMandatory` 闸门保证）—— 给一个只是**接受**这个参数的上游填值，
 * 是凭空造出一条它本来没有的约束：实测 CloudCode 把 thinkingBudget 算进 maxOutputTokens，
 * 补一个 4096 会让 18/807 条真实请求从「能编译」变成 422（DEFECT-10）。
 *
 * `source` 是 `gateway-default`：下游看到 client 与 gateway 的区别，冲突时才知道该听谁的。
 */
export function fillDefaultMaxOutputTokens(
  request: IRRequest, options: OptionsOf<"defaultMaxOutputTokens">,
): IRRepairResult {
  const { intent } = request;
  if (intent.stopping.maxOutputTokens !== undefined) return { request, applied: [] };
  const next: IRRequest = {
    ...request,
    intent: { ...intent, stopping: { ...intent.stopping, maxOutputTokens: defaultValue(options.tokens) } },
  };
  return repaired(request, next, [{
    kind: "defaultMaxOutputTokens",
    path: "$.intent.stopping.maxOutputTokens",
    detail:
      `gateway picked an output ceiling of ${options.tokens} tokens because the client stated none; ` +
      `a longer answer than this will come back truncated with stopReason=maxTokens`,
  }]);
}

// ── raiseMaxOutputTokens ────────────────────────────────────────────────────

/**
 * 抬高客户端**明确说出口**的输出上限。
 *
 * 与 `defaultMaxOutputTokens` 的分界只有一句话：那条填的是**客户端没说过的空位**，
 * 这条改的是**客户端说过的话**。后者重得多 —— 上限是成本约束，抬高它等于替客户端多花钱，
 * 所以它默认关闭（与本层所有修复一样，键缺席即不修），且 detail 必须把「客户端说了 N、
 * 网关抬到 M、为什么」三件事写全，否则调用方在账单上看到的就是一个无从解释的数字。
 *
 * 为什么它是 `targetIndependent`：把思考预算算进输出上限**不是某一家的怪癖**。
 * CloudCode 实测 `maxOutputTokens` 含 thinkingBudget（低于 budget + 可见正文下限时上游
 * 回 200 空正文）；Anthropic 的 extended thinking 同样要求 `budget_tokens < max_tokens`，
 * 否则直接 400。一个低于自己思考预算的上限在任何这类目标上都是无解的组合。
 *
 * **它不保证修好**：目标要求的下限可能高于 `minimumTokens`（例如客户端只给了 effort，
 * 由出口按自己的档位表折算出更高的预算）。修不动就仍然拒绝 —— 这一层不去复刻出口的档位表，
 * 复刻出来的就是第二份会漂移的认知。
 */
export function raiseMaxOutputTokens(
  request: IRRequest, options: OptionsOf<"raiseMaxOutputTokens">,
): IRRepairResult {
  const { intent } = request;
  const stated = intent.stopping.maxOutputTokens;
  // 只动客户端明说的值。没说的那种是 defaultMaxOutputTokens 的地盘，两条修复不许重叠。
  if (stated === undefined || stated.source !== "client") return { request, applied: [] };

  // 客户端自己说了思考预算时，「够用」是算得出来的：预算 + 可见正文额度。
  // 只给了 effort 的客户端一个数字都没说过，那条路上只有 minimumTokens 这个兜底。
  const budget = intent.reasoning.value.budgetTokens;
  const raised = Math.max(
    options.minimumTokens,
    budget === undefined ? 0 : budget + options.visibleOutputTokens,
  );
  if (stated.value >= raised) return { request, applied: [] };

  const next: IRRequest = {
    ...request,
    intent: {
      ...intent,
      stopping: { ...intent.stopping, maxOutputTokens: defaultValue(raised) },
    },
  };
  return repaired(request, next, [{
    kind: "raiseMaxOutputTokens",
    path: "$.intent.stopping.maxOutputTokens",
    detail:
      `the client asked for a ceiling of ${stated.value} tokens and the gateway raised it to ` +
      `${raised} because the target counts the thinking budget inside this same ceiling; ` +
      `at ${stated.value} the request either compiles to nothing usable or comes back with an empty body, ` +
      `but the client's stated cost ceiling has been overridden and the answer may cost more than it asked for`,
  }]);
}
