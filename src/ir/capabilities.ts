/**
 * 从 L0/L1 推导 L2 的能力需求。
 *
 * 需求是**推导出来的**，不是 decode 时手写的：手写会随着入口增多而漂移，
 * 而这里只有一个函数，任何新增的 part/intent 形态都必须在这里表态，否则编译期就漏不掉。
 */
import type {
  IRCapability, IRCapabilityNeed, IRConversation, IRIntent, IRPart, IRRequest,
} from "./types.ts";

class NeedCollector {
  readonly #needs = new Map<IRCapability, Set<string>>();

  add(capability: IRCapability, path: string): void {
    const paths = this.#needs.get(capability);
    if (paths === undefined) this.#needs.set(capability, new Set([path]));
    // 只留前若干条路径：需求是布尔的，路径只为把错误指到位置，全留会让深层会话产生上万条。
    else if (paths.size < 8) paths.add(path);
  }

  collect(): IRCapabilityNeed[] {
    return [...this.#needs.entries()].map(([capability, paths]) => ({ capability, paths: [...paths] }));
  }
}

function collectPartNeeds(part: IRPart, path: string, needs: NeedCollector): void {
  if (part.cacheBreakpoint !== undefined) needs.add("cacheBreakpoint", `${path}.cacheBreakpoint`);
  switch (part.kind) {
    case "text":
      break;
    case "image":
      needs.add("image", path);
      break;
    case "document":
      needs.add("document", path);
      break;
    case "thinking":
      needs.add("thinking", path);
      if (part.signature !== undefined) needs.add("thinkingSignature", path);
      break;
    case "redactedThinking":
      needs.add("thinking", path);
      break;
    case "toolCall":
      if (part.call.input.kind === "text") needs.add("toolFreeform", path);
      if (part.call.toolRef.group !== null) needs.add("toolGroup", path);
      break;
    case "toolResult": {
      if (part.result.status === "error") needs.add("toolResultError", path);
      part.result.parts.forEach((inner, index) => {
        if (inner.kind === "image") needs.add("toolResultImage", `${path}.result.parts[${index}]`);
        collectPartNeeds(inner, `${path}.result.parts[${index}]`, needs);
      });
      break;
    }
    // opaque 不产生需求：它的处置由每个 outbox 显式决定并记 loss，
    // 在这里映射成某个能力等于替 outbox 猜它是什么。
    case "opaque":
      break;
  }
}

function collectConversationNeeds(conversation: IRConversation, needs: NeedCollector): void {
  if (conversation.system.length > 0) needs.add("systemPrompt", "$.conversation.system");
  conversation.system.forEach((part, index) =>
    collectPartNeeds(part, `$.conversation.system[${index}]`, needs));

  if (conversation.turns.length > 1) needs.add("multiTurn", "$.conversation.turns");
  conversation.turns.forEach((turn, turnIndex) => {
    turn.parts.forEach((part, partIndex) =>
      collectPartNeeds(part, `$.conversation.turns[${turnIndex}].parts[${partIndex}]`, needs));
  });

  const { toolset } = conversation;
  toolset.tools.forEach((tool, index) => {
    const path = `$.conversation.toolset.tools[${index}]`;
    if (tool.kind === "function") needs.add("toolFunction", path);
    if (tool.kind === "freeform") needs.add("toolFreeform", path);
    if (tool.kind === "builtin") needs.add("toolBuiltin", path);
    if (tool.ref.group !== null) needs.add("toolGroup", path);
  });
  if (toolset.groups.length > 0) needs.add("toolGroup", "$.conversation.toolset.groups");
  if (toolset.choice.value.kind === "specific") needs.add("toolChoiceSpecific", "$.conversation.toolset.choice");
  if (toolset.parallel.source === "client" && toolset.parallel.value) {
    needs.add("toolParallel", "$.conversation.toolset.parallel");
  }
}

function collectIntentNeeds(intent: IRIntent, needs: NeedCollector): void {
  const reasoningPath = "$.intent.reasoning";
  const reasoning = intent.reasoning.value;
  // 三个维度各自表态：mode 决定要不要思考，effort/budget 是两种独立的强度表达，
  // 出口支持哪种由它自己的 profile 说了算。
  if (reasoning.mode !== "disabled") needs.add("thinking", reasoningPath);
  if (reasoning.effort !== undefined) needs.add("reasoningEffort", `${reasoningPath}.effort`);
  if (reasoning.budgetTokens !== undefined) needs.add("reasoningBudget", `${reasoningPath}.budgetTokens`);

  if (intent.outputFormat.value.kind === "jsonSchema") needs.add("structuredOutput", "$.intent.outputFormat");
  if (intent.contextEdits.length > 0) needs.add("contextEdit", "$.intent.contextEdits");
  if (intent.serviceTier.source === "client" && intent.serviceTier.value === "priority") {
    needs.add("serviceTier", "$.intent.serviceTier");
  }
  if (intent.stopping.maxOutputTokens !== undefined) needs.add("maxOutputTokens", "$.intent.stopping.maxOutputTokens");
  if (intent.stopping.stopSequences !== undefined) needs.add("stopSequences", "$.intent.stopping.stopSequences");
  if (intent.sampling.temperature !== undefined) needs.add("temperature", "$.intent.sampling.temperature");
  if (intent.sampling.topP !== undefined) needs.add("topP", "$.intent.sampling.topP");
  if (intent.sampling.topK !== undefined) needs.add("topK", "$.intent.sampling.topK");
  needs.add(intent.stream.value ? "stream" : "nonStream", "$.intent.stream");
}

export function deriveCapabilityNeeds(request: Omit<IRRequest, "requires">): IRCapabilityNeed[] {
  const needs = new NeedCollector();
  collectConversationNeeds(request.conversation, needs);
  collectIntentNeeds(request.intent, needs);
  return needs.collect();
}
