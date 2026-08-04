/**
 * Repair 层。
 *
 * 这一层的价值判据只有一个：**原本被 `checkUpstreamSupport` 拒掉的请求，在调用方明确
 * 同意某种降级之后能过**。所以除了逐种修复的正/反用例，必须有一条端到端断言把
 * 「拒 → 修 → 过」串起来（`makes a rejected request admissible`）。
 *
 * 枚举完整性不靠人肉核对：`CASES` 是以 `IRRepairKind` 为键的**映射类型**，
 * 新增一种修复而不给用例，这个文件当场编译失败。
 */
import { describe, expect, it } from "bun:test";
import { createChatCompletionsUpstream } from "../src/egress/openai_chat_completions.ts";
import { checkUpstreamSupport } from "../src/ir/admission.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import {
  IR_CAPABILITIES, clientValue, defaultValue,
  type IRCapability, type IRConversation, type IREgressProfile, type IRIntent, type IROutputFormat,
  type IRPart, type IRReasoning, type IRRequest, type IRToolChoice, type IRTurn,
} from "../src/ir/types.ts";
import {
  IR_REPAIR_KINDS, IR_REPAIR_POLICY_NONE, IR_REPAIR_SPECS,
  describeRepairsAsLosses, repairForAdmission, repairIRRequest,
  type IRRepairKind, type IRRepairPolicy,
} from "../src/repair/index.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────

function irRequest(over: {
  readonly conversation?: Partial<IRConversation>;
  readonly intent?: Partial<IRIntent>;
}): IRRequest {
  const conversation: IRConversation = {
    system: [],
    turns: [],
    toolset: {
      tools: [], groups: [],
      choice: defaultValue<IRToolChoice>({ kind: "auto" }),
      parallel: defaultValue(true),
    },
    ...over.conversation,
  };
  const intent: IRIntent = {
    reasoning: defaultValue<IRReasoning>({ mode: "disabled", display: "hidden" }),
    outputFormat: defaultValue<IROutputFormat>({ kind: "text" }),
    serviceTier: defaultValue("standard" as const),
    sampling: {}, stopping: {}, contextEdits: [],
    stream: defaultValue(false), identity: {},
    ...over.intent,
  };
  const partial = {
    traceId: "tr-repair", protocol: "anthropic_messages" as const, model: "m", conversation, intent,
  };
  return deepFreeze({ ...partial, requires: deriveCapabilityNeeds(partial) });
}

const turns = (...list: readonly IRTurn[]): Partial<IRConversation> => ({ turns: list });
const user = (...parts: readonly IRPart[]): IRTurn => ({ role: "user", parts });
const assistant = (...parts: readonly IRPart[]): IRTurn => ({ role: "assistant", parts });

const text = (value: string): IRPart => ({ kind: "text", text: value });
const image = (): IRPart => ({
  kind: "image",
  media: { source: { kind: "base64", data: "AAAA" }, mediaType: "image/png", bytes: 3 },
});
const document = (title?: string): IRPart => ({
  kind: "document",
  media: { source: { kind: "base64", data: "AAAA" }, mediaType: "application/pdf", bytes: 3 },
  ...(title === undefined ? {} : { title }),
});
const toolCall = (id: string, name = "Bash"): IRPart => ({
  kind: "toolCall",
  call: { id, toolRef: { group: null, name }, input: { kind: "json", value: {} } },
});
const toolResult = (callId: string, ...parts: readonly IRPart[]): IRPart => ({
  kind: "toolResult",
  result: { callId, parts, status: "ok" },
});

const profileOf = (
  supports: readonly IRCapability[], lossy: readonly IRCapability[] = [],
): IREgressProfile => ({ provider: "test", supports: new Set(supports), lossy: new Set(lossy) });

const EVERYTHING = profileOf(IR_CAPABILITIES);
const NOTHING = profileOf([]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const snapshot = (request: IRRequest): string => JSON.stringify(request);

// ── 每种修复的正/反用例 ─────────────────────────────────────────────────────

interface RepairScenario {
  readonly request: IRRequest;
  readonly profile: IREgressProfile;
}

interface RepairCase {
  /** 只启用这一种。 */
  readonly policy: IRRepairPolicy;
  /** 必须触发。 */
  readonly triggering: RepairScenario;
  /** 必须**不**触发（且返回入参对象本身）。 */
  readonly inert: readonly RepairScenario[];
}

/**
 * 种类 → 用例。以 `IRRepairKind` 为键的映射类型：新增一种修复而不在这里给用例，
 * 编译期就失败 —— 「每种修复都有正反用例」这条约束因此不依赖任何人的记性。
 */
const CASES: { readonly [K in IRRepairKind]: RepairCase } = {
  dropOrphanToolResult: {
    policy: { dropOrphanToolResult: {} },
    triggering: {
      request: irRequest({ conversation: turns(user(toolResult("c-missing", text("out")))) }),
      profile: EVERYTHING,
    },
    inert: [{
      request: irRequest({ conversation: turns(assistant(toolCall("c1")), user(toolResult("c1", text("out")))) }),
      profile: EVERYTHING,
    }],
  },

  fillDanglingToolCall: {
    policy: { fillDanglingToolCall: {} },
    triggering: {
      request: irRequest({ conversation: turns(user(text("go")), assistant(toolCall("c1"))) }),
      profile: EVERYTHING,
    },
    inert: [{
      request: irRequest({ conversation: turns(assistant(toolCall("c1")), user(toolResult("c1", text("out")))) }),
      profile: EVERYTHING,
    }],
  },

  fillEmptyToolResult: {
    policy: { fillEmptyToolResult: {} },
    triggering: {
      request: irRequest({ conversation: turns(assistant(toolCall("c1")), user(toolResult("c1"))) }),
      profile: EVERYTHING,
    },
    inert: [{
      request: irRequest({ conversation: turns(assistant(toolCall("c1")), user(toolResult("c1", text("out")))) }),
      profile: EVERYTHING,
    }],
  },

  textualizeUnsupportedImage: {
    policy: { textualizeUnsupportedImage: {} },
    triggering: { request: irRequest({ conversation: turns(user(image())) }), profile: NOTHING },
    inert: [
      // 目标支持图片 → 闸门就不该放行
      { request: irRequest({ conversation: turns(user(image())) }), profile: EVERYTHING },
      // 请求里根本没有图片
      { request: irRequest({ conversation: turns(user(text("hi"))) }), profile: NOTHING },
    ],
  },

  textualizeUnsupportedDocument: {
    policy: { textualizeUnsupportedDocument: {} },
    triggering: { request: irRequest({ conversation: turns(user(document("spec.pdf"))) }), profile: NOTHING },
    inert: [
      { request: irRequest({ conversation: turns(user(document("spec.pdf"))) }), profile: EVERYTHING },
      { request: irRequest({ conversation: turns(user(text("hi"))) }), profile: NOTHING },
    ],
  },

  dropEmptyTurn: {
    policy: { dropEmptyTurn: {} },
    triggering: {
      request: irRequest({ conversation: turns(user(text("hi")), assistant(text(""))) }),
      profile: EVERYTHING,
    },
    inert: [{
      request: irRequest({ conversation: turns(user(text("hi")), assistant(text("there"))) }),
      profile: EVERYTHING,
    }],
  },

  mergeAdjacentTurns: {
    policy: { mergeAdjacentTurns: {} },
    triggering: {
      request: irRequest({ conversation: turns(user(text("a")), user(text("b"))) }),
      profile: EVERYTHING,
    },
    inert: [{
      request: irRequest({ conversation: turns(user(text("a")), assistant(text("b"))) }),
      profile: EVERYTHING,
    }],
  },

  defaultMaxOutputTokens: {
    policy: { defaultMaxOutputTokens: {} },
    triggering: { request: irRequest({}), profile: EVERYTHING },
    inert: [
      // 客户端自己给了上限 → 不许覆盖
      { request: irRequest({ intent: { stopping: { maxOutputTokens: clientValue(64) } } }), profile: EVERYTHING },
      // 目标根本不认识这个参数 → 填了只会凭空造出一条准入过不去的需求
      { request: irRequest({}), profile: NOTHING },
    ],
  },
};

// ── 枚举完整性 ──────────────────────────────────────────────────────────────

describe("repair kind enumeration", () => {
  it("keeps IR_REPAIR_KINDS, the spec table and the case table in exact correspondence", () => {
    const declared: string[] = [...IR_REPAIR_KINDS].sort();
    expect(Object.keys(IR_REPAIR_SPECS).sort()).toEqual(declared);
    expect(Object.keys(CASES).sort()).toEqual(declared);
    // 每一行的 kind 必须与它的键一致（`IRRepairSpec<K>` 已在编译期绑死，这里守住运行时）
    for (const kind of IR_REPAIR_KINDS) expect(IR_REPAIR_SPECS[kind].kind).toBe(kind);
  });

  it("has no duplicate kinds", () => {
    expect(new Set(IR_REPAIR_KINDS).size).toBe(IR_REPAIR_KINDS.length);
  });

  it("gives every kind a reachable dispatch: enabling it alone actually fires it", () => {
    for (const kind of IR_REPAIR_KINDS) {
      const { policy, triggering } = CASES[kind];
      const { applied } = repairIRRequest(triggering.request, triggering.profile, policy);
      expect(applied.length).toBeGreaterThan(0);
      expect(applied.every((record) => record.kind === kind)).toBe(true);
      expect(applied.every((record) => record.path.startsWith("$."))).toBe(true);
      // detail 说的是「网关做了什么决定」，不是「发生了什么」
      expect(applied.every((record) => record.detail.includes("gateway"))).toBe(true);
    }
  });

  it("declares a loss category for every kind", () => {
    for (const kind of IR_REPAIR_KINDS) {
      expect(["dropped", "degraded", "substituted", "truncated"]).toContain(IR_REPAIR_SPECS[kind].lossKind);
    }
  });
});

// ── 默认策略：确定性 ────────────────────────────────────────────────────────

describe("default policy", () => {
  it("repairs nothing and returns the very same IRRequest object", () => {
    for (const kind of IR_REPAIR_KINDS) {
      const { triggering } = CASES[kind];
      const result = repairIRRequest(triggering.request, triggering.profile, IR_REPAIR_POLICY_NONE);
      expect(result.applied).toEqual([]);
      expect(result.request).toBe(triggering.request);
    }
  });

  it("leaves an IRRequest field-for-field unchanged", () => {
    const request = irRequest({
      conversation: turns(user(text("hi"), image(), document("d.pdf")), assistant(toolCall("c1"))),
      intent: { sampling: { temperature: clientValue(0.4) } },
    });
    const before = snapshot(request);
    const result = repairIRRequest(request, NOTHING, {});
    expect(snapshot(result.request)).toBe(before);
    expect(result.request).toBe(request);
  });
});

// ── 反向用例 ────────────────────────────────────────────────────────────────

describe("non-triggering inputs", () => {
  it("leaves the request untouched when the repair does not apply", () => {
    for (const kind of IR_REPAIR_KINDS) {
      const { policy, inert } = CASES[kind];
      inert.forEach((scenario, index) => {
        const result = repairIRRequest(scenario.request, scenario.profile, policy);
        expect(`${kind}#${index}: ${JSON.stringify(result.applied)}`).toBe(`${kind}#${index}: []`);
        expect(result.request).toBe(scenario.request);
      });
    }
  });
});

// ── 纯度 ────────────────────────────────────────────────────────────────────

describe("purity", () => {
  it("never mutates the input request", () => {
    for (const kind of IR_REPAIR_KINDS) {
      const { policy, triggering } = CASES[kind];
      const before = snapshot(triggering.request);
      const result = repairIRRequest(triggering.request, triggering.profile, policy);
      expect(snapshot(triggering.request)).toBe(before);
      expect(result.request).not.toBe(triggering.request);
    }
  });

  it("re-derives requires so the repaired IR is self-consistent on its own", () => {
    for (const kind of IR_REPAIR_KINDS) {
      const { policy, triggering } = CASES[kind];
      const { request } = repairIRRequest(triggering.request, triggering.profile, policy);
      expect([...request.requires].sort((a, b) => a.capability.localeCompare(b.capability)))
        .toEqual([...deriveCapabilityNeeds(request)].sort((a, b) => a.capability.localeCompare(b.capability)));
    }
  });
});

// ── 目标能力闸门 ────────────────────────────────────────────────────────────

describe("capability gate", () => {
  it("keeps targetIndependent repairs identical across opposite profiles", () => {
    for (const kind of IR_REPAIR_KINDS) {
      if (IR_REPAIR_SPECS[kind].capabilityGate.kind !== "targetIndependent") continue;
      const { policy, triggering } = CASES[kind];
      const permissive = repairIRRequest(triggering.request, EVERYTHING, policy);
      const restrictive = repairIRRequest(triggering.request, NOTHING, policy);
      expect(snapshot(restrictive.request)).toBe(snapshot(permissive.request));
      expect(restrictive.applied).toEqual(permissive.applied);
    }
  });

  it("does not textualize a tool-result image when only that one position is unsupported", () => {
    const request = irRequest({
      conversation: turns(user(image()), assistant(toolCall("c1")), user(toolResult("c1", image()))),
    });
    // image 支持、toolResultImage 不支持 —— openai_chat_completions 的真实形状
    const profile = profileOf(IR_CAPABILITIES.filter((capability) => capability !== "toolResultImage"));
    const { request: repaired, applied } = repairIRRequest(request, profile, { textualizeUnsupportedImage: {} });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.path).toBe("$.conversation.turns[2].parts[0].result.parts[0]");
    expect(repaired.conversation.turns[0]?.parts[0]?.kind).toBe("image");
  });

  it("honours the capabilityAbsentOrLossy trigger for a lossy target", () => {
    const profile = profileOf(IR_CAPABILITIES.filter((capability) => capability !== "document"), ["document"]);
    const request = irRequest({ conversation: turns(user(document("d.pdf"))) });
    expect(repairIRRequest(request, profile, { textualizeUnsupportedDocument: {} }).applied).toEqual([]);
    expect(repairIRRequest(request, profile, {
      textualizeUnsupportedDocument: { trigger: "capabilityAbsentOrLossy" },
    }).applied).toHaveLength(1);
  });
});

// ── 逐种修复的形状 ──────────────────────────────────────────────────────────

describe("dropOrphanToolResult", () => {
  it("removes only the result whose call is absent", () => {
    const request = irRequest({
      conversation: turns(assistant(toolCall("c1")), user(toolResult("c1", text("a")), toolResult("c9", text("b")))),
    });
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, { dropOrphanToolResult: {} });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.path).toBe("$.conversation.turns[1].parts[1]");
    expect(repaired.conversation.turns[1]?.parts).toHaveLength(1);
  });
});

describe("fillDanglingToolCall", () => {
  it("inserts the placeholder at the front of the following user turn", () => {
    const request = irRequest({
      conversation: turns(assistant(toolCall("c1"), toolCall("c2")), user(toolResult("c2", text("done")))),
    });
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, { fillDanglingToolCall: {} });
    expect(applied).toHaveLength(1);
    const parts = repaired.conversation.turns[1]?.parts ?? [];
    expect(parts).toHaveLength(2);
    const first = parts[0];
    expect(first?.kind === "toolResult" && first.result.callId).toBe("c1");
    expect(first?.kind === "toolResult" && first.result.status).toBe("missing");
  });

  it("appends a user turn when the assistant turn is last", () => {
    const request = irRequest({ conversation: turns(assistant(toolCall("c1"))) });
    const { request: repaired } = repairIRRequest(request, EVERYTHING, { fillDanglingToolCall: {} });
    expect(repaired.conversation.turns).toHaveLength(2);
    expect(repaired.conversation.turns[1]?.role).toBe("user");
  });

  it("tells the model the outcome is unknown rather than empty", () => {
    const request = irRequest({ conversation: turns(assistant(toolCall("c1", "Bash"))) });
    const { request: repaired } = repairIRRequest(request, EVERYTHING, { fillDanglingToolCall: {} });
    const placeholder = repaired.conversation.turns[1]?.parts[0];
    const body = placeholder?.kind === "toolResult" ? placeholder.result.parts[0] : undefined;
    const value = body?.kind === "text" ? body.text : "";
    expect(value).toContain("UNKNOWN");
    expect(value).toContain("Bash");
    expect(value).toContain("c1");
    expect(value).toContain("Do not assume it produced no output");
  });

  it("takes the caller's wording verbatim, tokens included", () => {
    const request = irRequest({ conversation: turns(assistant(toolCall("c1", "Read"))) });
    const { request: repaired } = repairIRRequest(request, EVERYTHING, {
      fillDanglingToolCall: { placeholderText: "工具 {toolName}（{callId}）的结果丢了，别当成成功。{unknownToken}" },
    });
    const placeholder = repaired.conversation.turns[1]?.parts[0];
    const body = placeholder?.kind === "toolResult" ? placeholder.result.parts[0] : undefined;
    // 未知 token 原样保留：悄悄换成空串会让配错的文案看起来像配对了
    expect(body?.kind === "text" && body.text).toBe("工具 Read（c1）的结果丢了，别当成成功。{unknownToken}");
  });
});

describe("fillEmptyToolResult", () => {
  it("fills a result that carries only empty text", () => {
    const request = irRequest({
      conversation: turns(assistant(toolCall("c1")), user(toolResult("c1", text("")))),
    });
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, { fillEmptyToolResult: {} });
    expect(applied).toHaveLength(1);
    const part = repaired.conversation.turns[1]?.parts[0];
    const body = part?.kind === "toolResult" ? part.result.parts[0] : undefined;
    expect(body?.kind === "text" && body.text).toContain("returned no content");
  });
});

describe("textualize", () => {
  it("replaces the image with a description that names the media type and forbids invention", () => {
    const request = irRequest({ conversation: turns(user(image())) });
    const { request: repaired } = repairIRRequest(request, NOTHING, { textualizeUnsupportedImage: {} });
    const part = repaired.conversation.turns[0]?.parts[0];
    expect(part?.kind).toBe("text");
    expect(part?.kind === "text" && part.text).toContain("image/png");
    expect(part?.kind === "text" && part.text).toContain("You have NOT seen this image");
  });

  it("keeps the cache breakpoint that was annotated on the replaced part", () => {
    const annotated: IRPart = { ...image(), cacheBreakpoint: { scope: "ephemeral" } } as IRPart;
    const request = irRequest({ conversation: turns(user(annotated)) });
    const { request: repaired } = repairIRRequest(request, NOTHING, { textualizeUnsupportedImage: {} });
    expect(repaired.conversation.turns[0]?.parts[0]?.cacheBreakpoint).toEqual({ scope: "ephemeral" });
  });

  it("repairs documents inside system parts too", () => {
    const request = irRequest({ conversation: { system: [document("policy.pdf")], turns: [user(text("hi"))] } });
    const { request: repaired, applied } = repairIRRequest(request, NOTHING, { textualizeUnsupportedDocument: {} });
    expect(applied[0]?.path).toBe("$.conversation.system[0]");
    expect(repaired.conversation.system[0]?.kind).toBe("text");
  });

  it("takes the caller's document wording", () => {
    const request = irRequest({ conversation: turns(user(document("spec.pdf"))) });
    const { request: repaired } = repairIRRequest(request, NOTHING, {
      textualizeUnsupportedDocument: { placeholderText: "[略过文档 {title} / {mediaType}]" },
    });
    const part = repaired.conversation.turns[0]?.parts[0];
    expect(part?.kind === "text" && part.text).toBe("[略过文档 spec.pdf / application/pdf]");
  });
});

describe("dropEmptyTurn", () => {
  it("drops the empty turn and reports the client's own index", () => {
    const request = irRequest({
      conversation: turns(user(text("")), assistant(text("hi")), user(text(""), text("real"))),
    });
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, { dropEmptyTurn: {} });
    expect(applied.map((record) => record.path))
      .toEqual(["$.conversation.turns[0]", "$.conversation.turns[2].parts[0]"]);
    expect(repaired.conversation.turns).toHaveLength(2);
  });

  it("keeps an empty text part that carries a cache breakpoint", () => {
    const marker: IRPart = { kind: "text", text: "", cacheBreakpoint: { scope: "ephemeral" } };
    const request = irRequest({ conversation: turns(user(marker)) });
    expect(repairIRRequest(request, EVERYTHING, { dropEmptyTurn: {} }).applied).toEqual([]);
  });
});

describe("mergeAdjacentTurns", () => {
  it("folds a run of same-role turns into one, in order", () => {
    const request = irRequest({
      conversation: turns(user(text("a")), user(text("b")), user(text("c")), assistant(text("d"))),
    });
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, { mergeAdjacentTurns: {} });
    expect(applied).toHaveLength(2);
    expect(repaired.conversation.turns).toHaveLength(2);
    expect(repaired.conversation.turns[0]?.parts.map((part) => (part.kind === "text" ? part.text : "")))
      .toEqual(["a", "b", "c"]);
  });
});

describe("defaultMaxOutputTokens", () => {
  it("marks the value as a gateway default, not a client statement", () => {
    const { request: repaired, applied } = repairIRRequest(irRequest({}), EVERYTHING, { defaultMaxOutputTokens: {} });
    expect(repaired.intent.stopping.maxOutputTokens).toEqual({ value: 4096, source: "gateway-default" });
    expect(applied[0]?.detail).toContain("4096");
  });

  it("takes the caller's ceiling", () => {
    const { request: repaired } = repairIRRequest(irRequest({}), EVERYTHING, {
      defaultMaxOutputTokens: { tokens: 8192 },
    });
    expect(repaired.intent.stopping.maxOutputTokens?.value).toBe(8192);
  });
});

// ── compose ────────────────────────────────────────────────────────────────

describe("compose", () => {
  it("runs enabled repairs in IR_REPAIR_KINDS order regardless of how the policy is written", () => {
    const request = irRequest({
      conversation: turns(
        user(toolResult("c-orphan", text("x"))),
        assistant(toolCall("c1")),
        user(text("")),
      ),
    });
    // 策略键序与流水线顺序相反，结果必须与顺序无关
    const written: IRRepairPolicy = { dropEmptyTurn: {}, fillDanglingToolCall: {}, dropOrphanToolResult: {} };
    const { request: repaired, applied } = repairIRRequest(request, EVERYTHING, written);
    expect(applied.map((record) => record.kind)).toEqual([
      "dropOrphanToolResult",
      "fillDanglingToolCall",
      // 摘掉孤儿之后那条 user 回合空了，由后一步收拾 —— 每种修复只做自己那一个决定
      "dropEmptyTurn",
      "dropEmptyTurn",
    ]);
    // 孤儿没了、悬空补上了、空回合被后续修复吸收
    const flattened = repaired.conversation.turns.flatMap((turn) => turn.parts.map((part) => part.kind));
    expect(flattened).toEqual(["toolCall", "toolResult"]);
  });

  it("maps records onto IRLoss with the category declared by the spec table", () => {
    const request = irRequest({ conversation: turns(user(document("d.pdf"), toolResult("c-orphan"))) });
    const { applied } = repairIRRequest(request, NOTHING, {
      dropOrphanToolResult: {}, textualizeUnsupportedDocument: {},
    });
    const losses = describeRepairsAsLosses(applied, "test");
    expect(losses.map((loss) => loss.kind)).toEqual(["dropped", "degraded"]);
    expect(losses.every((loss) => loss.stage === "egress" && loss.provider === "test")).toBe(true);
  });
});

// ── 端到端：这一层存在的意义 ────────────────────────────────────────────────

describe("admission", () => {
  const chat = createChatCompletionsUpstream({
    baseUrl: "https://api.openai.com/v1/", apiKey: "sk-test", model: "gpt-5-mini",
  }).profile;

  const withUnsupportedModalities = irRequest({
    conversation: turns(
      user(text("look at this"), document("spec.pdf")),
      assistant(toolCall("c1")),
      user(toolResult("c1", image())),
    ),
  });

  it("is rejected by the real chat profile before any repair", () => {
    const check = checkUpstreamSupport(withUnsupportedModalities, chat);
    expect(check.admitted).toBe(false);
    expect(check.unsupported.map((need) => need.capability).sort()).toEqual(["document", "toolResultImage"]);
  });

  it("passes once the caller opts into the two textualising repairs", () => {
    const { request, applied, admission } = repairForAdmission(withUnsupportedModalities, chat, {
      textualizeUnsupportedImage: {}, textualizeUnsupportedDocument: {},
    });
    expect(admission.admitted).toBe(true);
    expect(admission.unsupported).toEqual([]);
    expect(applied.map((record) => record.kind).sort())
      .toEqual(["textualizeUnsupportedDocument", "textualizeUnsupportedImage"]);
    // 顶层图片这家上游本来就支持，不该被牵连
    expect(request.conversation.turns[0]?.parts[0]?.kind).toBe("text");
    expect(checkUpstreamSupport(request, chat).admitted).toBe(true);
  });

  it("still rejects when the caller opts into nothing", () => {
    const { admission } = repairForAdmission(withUnsupportedModalities, chat, IR_REPAIR_POLICY_NONE);
    expect(admission.admitted).toBe(false);
  });
});
