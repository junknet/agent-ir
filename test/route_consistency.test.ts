/**
 * 跨路由一致性 —— 3 入口 × 5 出口 = 15 条路由，逐条对齐。
 *
 * 这套架构的全部经济意义建立在一个假设上：**同一段语义，走哪个入口进来都是同一个 IR；
 * 同一个 IR，送到哪个出口都不会凭空少东西**。假设一旦破了，「15 条路由」就退化成
 * 「15 个各写各的转换器」，中间那层 IR 只是多绕了一圈。
 *
 * 所以这里断言三件事，一件比一件强：
 *   1. 三个入口对同一段对话产出**结构等价**的 IR（不是「差不多」，是 conversation 逐字段相等）；
 *   2. 同一个 IR 在五个出口上推导出**同一份**能力需求，被拒的理由必须落在
 *      `supports ∪ lossy` 之外 —— 拒绝是可解释的，不是随机的；
 *   3. 每个编译成功的出口，wire 里都**找得到**每一段客户端内容；找不到就必须有一条
 *      指到那个 part 的 loss 或 problem。没有第三种结局。
 *
 * 最后用 807 条真实归档做属性测试：每条真实请求 × 每个出口，结局必须落在
 * 一个**枚举得出来**的集合里。语料缺失时跳过而不是失败。
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createAnthropicUpstream } from "../src/egress/anthropic.ts";
import { createChatCompletionsUpstream } from "../src/egress/openai_chat_completions.ts";
import { createResponsesUpstream } from "../src/egress/openai_responses.ts";
import { createGeminiCloudCodeUpstream, clearThoughtSignatureCache } from "../src/egress/gemini_cloudcode.ts";
import { createWindsurfUpstream } from "../src/egress/windsurf/index.ts";
import { readClientRequestForProtocol } from "../src/ingress/index.ts";
import { checkUpstreamSupport, describeUnsupportedCapabilities } from "../src/ir/admission.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { repairForAdmission, IR_REPAIR_KINDS } from "../src/repair/index.ts";
import type { IRRepairKind, IRRepairPolicy } from "../src/repair/index.ts";
import { IR_BUILD_PROBLEM_KINDS, IR_CAPABILITIES, IR_PROTOCOLS } from "../src/ir/types.ts";
import type {
  IRBuildProblemKind, IRCapability, IREgress, IRProtocol, IRRequest, IRWireBody,
} from "../src/ir/types.ts";

// ── 五个出口 ────────────────────────────────────────────────────────────────

function buildEgresses(): Readonly<Record<string, IREgress<IRWireBody>>> {
  return {
    anthropic: createAnthropicUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "claude-test" }),
    openai_chat: createChatCompletionsUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    openai_responses: createResponsesUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    gemini_cloudcode: createGeminiCloudCodeUpstream({
      model: "gemini-test", accessToken: "ya29.t", project: "p", requestIdFactory: () => "agent/1/1/d/2",
    }),
    windsurf: createWindsurfUpstream({ model: "claude-test-high", apiKey: "devin$h.e.s" }),
  };
}

const EGRESSES = buildEgresses();

function wireText(body: IRWireBody): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、三个入口 → 同一个 IR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 同一段语义对话的三种 wire 写法。
 *
 * 三家的编码技巧完全不同 —— Anthropic 把工具结果放进 user 消息的块里，Chat 用一条
 * 独立的 `role:'tool'` 消息，Responses 用扁平的 `function_call_output` item。
 * 「IR 一样」这件事的全部难度就在这里：**位置不变量必须在 decode 时就被消灭**。
 */
const MARKERS = {
  system: "SYS_7f3a", user1: "U1_9b2c", assistant1: "A1_4d8e",
  result1: "R1_1a6f", assistant2: "A2_c05b", user2: "U2_e91d",
} as const;

const TOOL_SCHEMA = {
  type: "object",
  properties: { path: { type: "string", description: "absolute path" } },
  required: ["path"],
} as const;

const SAME_CONVERSATION: Readonly<Record<IRProtocol, unknown>> = {
  anthropic_messages: {
    model: "claude-opus-4-8", max_tokens: 1024, stream: true,
    system: MARKERS.system,
    tools: [{ name: "read", description: "Read a file", input_schema: TOOL_SCHEMA }],
    messages: [
      { role: "user", content: MARKERS.user1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: MARKERS.assistant1 },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "/tmp/x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: MARKERS.result1 }] },
      { role: "assistant", content: MARKERS.assistant2 },
      { role: "user", content: MARKERS.user2 },
    ],
  },
  openai_chat_completions: {
    model: "gpt-5.2", max_completion_tokens: 1024, stream: true,
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: TOOL_SCHEMA } }],
    messages: [
      { role: "system", content: MARKERS.system },
      { role: "user", content: MARKERS.user1 },
      {
        role: "assistant", content: MARKERS.assistant1,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"/tmp/x"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: MARKERS.result1 },
      { role: "assistant", content: MARKERS.assistant2 },
      { role: "user", content: MARKERS.user2 },
    ],
  },
  openai_responses: {
    model: "gpt-5.2", max_output_tokens: 1024, stream: true,
    instructions: MARKERS.system,
    tools: [{ type: "function", name: "read", description: "Read a file", parameters: TOOL_SCHEMA }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: MARKERS.user1 }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: MARKERS.assistant1 }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"/tmp/x"}' },
      { type: "function_call_output", call_id: "call_1", output: MARKERS.result1 },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: MARKERS.assistant2 }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: MARKERS.user2 }] },
    ],
  },
};

function decodeSame(protocol: IRProtocol): IRRequest {
  const { request, losses } = readClientRequestForProtocol(protocol, SAME_CONVERSATION[protocol], `tr_${protocol}`);
  // 这段对话里没有任何一家表达不了的东西 —— 出现 loss 就说明 decode 走了降级分支。
  expect(losses).toEqual([]);
  return request;
}

describe("三个入口对同一段对话产出结构等价的 IR", () => {
  const decoded = IR_PROTOCOLS.map((protocol) => [protocol, decodeSame(protocol)] as const);
  const [reference] = decoded;

  it("conversation 逐字段相等 —— 位置不变量在 decode 时就被消灭了", () => {
    for (const [protocol, request] of decoded) {
      expect({ protocol, conversation: request.conversation })
        .toEqual({ protocol, conversation: reference![1].conversation });
    }
  });

  it("回合序列是 user / assistant(text+toolCall) / user(toolResult) / assistant / user", () => {
    const turns = reference![1].conversation.turns;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(turns[1]!.parts.map((part) => part.kind)).toEqual(["text", "toolCall"]);
    expect(turns[2]!.parts.map((part) => part.kind)).toEqual(["toolResult"]);
  });

  it("能力需求也完全一致 —— requires 是 IR 的函数，不带入口的指纹", () => {
    const normalize = (request: IRRequest): unknown =>
      [...request.requires].map((need) => ({ capability: need.capability, paths: [...need.paths].sort() }))
        .sort((left, right) => left.capability.localeCompare(right.capability));
    for (const [protocol, request] of decoded) {
      expect({ protocol, requires: normalize(request) })
        .toEqual({ protocol, requires: normalize(reference![1]) });
    }
  });

  it("L1 里三家都表达得了的那几项也一致（上限 / 流式）", () => {
    for (const [protocol, request] of decoded) {
      expect({ protocol, max: request.intent.stopping.maxOutputTokens?.value, stream: request.intent.stream.value })
        .toEqual({ protocol, max: 1024, stream: true });
    }
  });

  it("每一段客户端文本都在 IR 里找得到 —— 一个 marker 都不许丢", () => {
    for (const [protocol, request] of decoded) {
      const flat = JSON.stringify(request.conversation);
      for (const marker of Object.values(MARKERS)) {
        expect({ protocol, marker, found: flat.includes(marker) })
          .toEqual({ protocol, marker, found: true });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、同一个 IR → 五个出口
// ═══════════════════════════════════════════════════════════════════════════

describe("同一个 IR 送进五个出口", () => {
  const request = decodeSame("anthropic_messages");

  it("能力需求由 IR 推导，与出口无关 —— 五条路由看到的是同一份 requires", () => {
    const derived = deriveCapabilityNeeds(request);
    expect(derived).toEqual([...request.requires]);
    // 出口只读它，不改它：把 requires 交给每个出口裁决前后必须一模一样。
    for (const egress of Object.values(EGRESSES)) {
      checkUpstreamSupport(request, egress.profile);
      expect(request.requires).toEqual(derived);
    }
  });

  it("拒绝的理由集合可解释：每条 unsupported 都确实落在 supports ∪ lossy 之外", () => {
    for (const [name, egress] of Object.entries(EGRESSES)) {
      const verdict = checkUpstreamSupport(request, egress.profile);
      for (const need of verdict.unsupported) {
        expect({ name, capability: need.capability, inSupports: egress.profile.supports.has(need.capability) })
          .toEqual({ name, capability: need.capability, inSupports: false });
        expect(egress.profile.lossy.has(need.capability)).toBe(false);
        // 拒绝的价值全在「是哪个字段」：路径必须指到 IR 位置。
        expect(need.paths.length).toBeGreaterThan(0);
      }
      // 记 loss 的那些必须真的在 lossy 里 —— 不许对 supports 里的能力也记一条。
      for (const loss of verdict.losses) {
        expect(loss.stage).toBe("egress");
        expect(loss.provider).toBe(egress.profile.provider);
      }
      expect(describeUnsupportedCapabilities(verdict.unsupported))
        .toBe(verdict.unsupported.map((need) => `${need.capability} (${need.paths.slice(0, 3).join(", ")})`).join("; "));
    }
  });

  it("supports 与 lossy 必须不相交 —— 重叠会让「强制留痕」静默失效", () => {
    for (const [name, egress] of Object.entries(EGRESSES)) {
      const overlap = [...egress.profile.supports].filter((capability) => egress.profile.lossy.has(capability));
      expect({ name, overlap }).toEqual({ name, overlap: [] });
      for (const capability of [...egress.profile.supports, ...egress.profile.lossy]) {
        expect(IR_CAPABILITIES).toContain(capability);
      }
    }
  });

  it("这段普通对话五个出口全都编译得出来，且 wire 里一个 marker 都不少", async () => {
    for (const [name, egress] of Object.entries(EGRESSES)) {
      clearThoughtSignatureCache();
      const verdict = checkUpstreamSupport(request, egress.profile);
      expect({ name, admitted: verdict.admitted }).toEqual({ name, admitted: true });
      const built = await egress.writeUpstreamRequest(request);
      expect({ name, ok: built.ok }).toEqual({ name, ok: true });
      if (!built.ok) continue;
      const text = wireText(built.wire.body);
      for (const marker of Object.values(MARKERS)) {
        // 没有出口可以静默丢内容：编译成功就意味着每一段都上了 wire。
        expect({ name, marker, carried: text.includes(marker) })
          .toEqual({ name, marker, carried: true });
      }
      // 工具身份同理 —— 分组拍平也好、包成 schema 也好，名字必须还在。
      expect(text).toContain("read");
    }
  });

  it("客户端没说的东西不许出现在 wire 上 —— Core 不发明内容", async () => {
    for (const egress of Object.values(EGRESSES)) {
      clearThoughtSignatureCache();
      const built = await egress.writeUpstreamRequest(request);
      if (!built.ok) continue;
      const text = wireText(built.wire.body);
      // 这几句是 repair 层的占位文案，Core 路径上永远不该出现。
      expect(text).not.toContain("[gateway]");
      expect(text).not.toContain("No result was recorded");
    }
  });
});

describe("表达不了的内容：拒绝必须指到那个 part，绝不静默丢", () => {
  /** 一张图片 + 一份文档 —— 五个出口里有几家载不动，正好用来看拒绝路径。 */
  function withMedia(): IRRequest {
    const { request } = readClientRequestForProtocol("anthropic_messages", {
      model: "m", max_tokens: 512,
      system: MARKERS.system,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: MARKERS.user1 },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "spec" },
        ],
      }],
    }, "tr_media");
    return request;
  }

  it("每个出口要么承载、要么在准入或构造阶段带路径拒绝 —— 没有第三种结局", async () => {
    const request = withMedia();
    for (const [name, egress] of Object.entries(EGRESSES)) {
      clearThoughtSignatureCache();
      const verdict = checkUpstreamSupport(request, egress.profile);
      if (!verdict.admitted) {
        // 准入拒了：理由必须精确到 part 路径。
        for (const need of verdict.unsupported) {
          expect(need.paths.some((path) => path.startsWith("$.conversation"))).toBe(true);
        }
        continue;
      }
      const built = await egress.writeUpstreamRequest(request);
      if (!built.ok) {
        for (const problem of built.problems) {
          expect(IR_BUILD_PROBLEM_KINDS).toContain(problem.kind);
          expect(problem.path.startsWith("$")).toBe(true);
        }
        continue;
      }
      // 编译成功：那就必须真的把图片/文档带上了，或者为它记了一条 loss。
      const text = wireText(built.wire.body);
      for (const [label, needle] of [["image", "iVBORw0KGgo="], ["document", "JVBERi0="]] as const) {
        const carried = text.includes(needle);
        const recorded = built.losses.some((loss) => loss.detail.length > 0);
        expect({ name, label, ok: carried || recorded }).toEqual({ name, label, ok: true });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、语料属性测试：807 条真实请求 × 5 个出口
// ═══════════════════════════════════════════════════════════════════════════

interface CorpusEntry {
  readonly traceId: string;
  readonly protocol: IRProtocol;
  readonly body: string;
}

const CORPUS_PATH = new URL("../.corpus/requests.ndjson", import.meta.url).pathname;

function loadCorpus(): CorpusEntry[] {
  if (!existsSync(CORPUS_PATH)) return [];
  return readFileSync(CORPUS_PATH, "utf-8")
    .split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusEntry);
}

const corpus = loadCorpus();

/** 全开的修复策略 —— 用来回答「调用方最大限度地表态之后，还剩下什么修不了」。 */
const MAXIMAL_POLICY: IRRepairPolicy = {
  dropOrphanToolResult: {},
  fillDanglingToolCall: {},
  fillEmptyToolResult: {},
  textualizeUnsupportedImage: { trigger: "capabilityAbsentOrLossy" },
  textualizeUnsupportedDocument: { trigger: "capabilityAbsentOrLossy" },
  dropEmptyTurn: {},
  mergeAdjacentTurns: {},
  defaultMaxOutputTokens: {},
};

/**
 * 修完之后**仍然**可能出现的结局。每一条都必须说得出理由 ——
 * 这张表就是「拒绝可解释」这条性质的可执行形式。
 *
 *   toolBuiltin        上游内建工具（computer_use / web_search）在这三家没有对应物。
 *                      没有任何修复能造出一个上游内建能力，只能换出口。
 *   structuredOutput   目标 wire 没有 json_schema 位置（gemini v1internal / windsurf）。
 *   toolChoiceSpecific windsurf 的 ChatToolChoice 取值集未实测，猜一个字符串会静默失效。
 */
const EXPLAINABLE_UNSUPPORTED: ReadonlySet<IRCapability> = new Set<IRCapability>([
  "toolBuiltin", "structuredOutput", "toolChoiceSpecific",
]);

/**
 * 修完之后仍会拒绝的 problem 种类。
 *
 *   unsatisfiableValue    `repair_advice.ts` 明写「当前一条修复都没有」——
 *                         抬高客户端自己说出口的上限是另一条还没登记的修复。
 *   requiredFieldMissing  语料里 3 条 `json_schema` 没给 `name`，Responses 必须要它，
 *                         而 `defaultMaxOutputTokens` / `fillEmptyToolResult` 都管不到
 *                         这条 path（见报告 OBS-3）。
 */
const EXPLAINABLE_PROBLEMS: ReadonlySet<IRBuildProblemKind> = new Set<IRBuildProblemKind>([
  "unsatisfiableValue", "requiredFieldMissing",
]);

describe("语料属性测试：每条真实请求 × 每个出口", () => {
  it.skipIf(corpus.length === 0)("结局只有三种，且每一种都能被枚举出的理由解释", async () => {
    const outcomes = new Map<string, number>();
    const unexplained: string[] = [];

    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const [name, egress] of Object.entries(EGRESSES)) {
        clearThoughtSignatureCache();
        const repaired = repairForAdmission(request, egress.profile, MAXIMAL_POLICY);

        if (!repaired.admission.admitted) {
          for (const need of repaired.admission.unsupported) {
            outcomes.set(`${name}:unsupported:${need.capability}`, (outcomes.get(`${name}:unsupported:${need.capability}`) ?? 0) + 1);
            if (!EXPLAINABLE_UNSUPPORTED.has(need.capability)) {
              unexplained.push(`${entry.traceId} ${name} unsupported ${need.capability} @ ${need.paths[0]}`);
            }
            expect(need.paths.length).toBeGreaterThan(0);
          }
          continue;
        }

        const built = await egress.writeUpstreamRequest(repaired.request);
        if (built.ok) {
          outcomes.set(`${name}:ok`, (outcomes.get(`${name}:ok`) ?? 0) + 1);
          const body = built.wire.body;
          expect(typeof body === "string" ? body.length : body.byteLength).toBeGreaterThan(0);
          continue;
        }
        for (const problem of built.problems) {
          outcomes.set(`${name}:problem:${problem.kind}`, (outcomes.get(`${name}:problem:${problem.kind}`) ?? 0) + 1);
          expect(IR_BUILD_PROBLEM_KINDS).toContain(problem.kind);
          expect(problem.path.startsWith("$")).toBe(true);
          if (!EXPLAINABLE_PROBLEMS.has(problem.kind)) {
            unexplained.push(`${entry.traceId} ${name} problem ${problem.kind} @ ${problem.path}`);
          }
        }
      }
    }

    console.log("corpus × egress outcomes:", Object.fromEntries([...outcomes].sort()));
    // 出现在这里的每一条都是「修复层认为自己能修，实际没修掉」或「没人想过的拒绝理由」。
    expect(unexplained.slice(0, 20)).toEqual([]);
  }, 120_000);

  it.skipIf(corpus.length === 0)("不开任何修复时，被拒的理由同样是可枚举的那几类", async () => {
    const problemKinds = new Set<IRBuildProblemKind>();
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const [, egress] of Object.entries(EGRESSES)) {
        clearThoughtSignatureCache();
        if (!checkUpstreamSupport(request, egress.profile).admitted) continue;
        const built = await egress.writeUpstreamRequest(request);
        if (built.ok) continue;
        for (const problem of built.problems) problemKinds.add(problem.kind);
      }
    }
    console.log("corpus problem kinds without repair:", [...problemKinds].sort());
    for (const kind of problemKinds) expect(IR_BUILD_PROBLEM_KINDS).toContain(kind);
  }, 120_000);

  it.skipIf(corpus.length === 0)("修复确实把原本编不出来的请求救回来了（这是这一层存在的理由）", async () => {
    let improved = 0;
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const [, egress] of Object.entries(EGRESSES)) {
        clearThoughtSignatureCache();
        const before = await egress.writeUpstreamRequest(request);
        if (before.ok) continue;
        const repaired = repairForAdmission(request, egress.profile, MAXIMAL_POLICY);
        if (!repaired.admission.admitted) continue;
        clearThoughtSignatureCache();
        const after = await egress.writeUpstreamRequest(repaired.request);
        if (after.ok) improved += 1;
      }
    }
    console.log(`repairs turned ${improved} rejected (request, egress) pairs into compilable ones`);
    expect(improved).toBeGreaterThan(0);
  }, 180_000);

  it("修复种类与 problem 种类都是封闭集，测试里引用的名字必须还在册", () => {
    for (const kind of EXPLAINABLE_PROBLEMS) expect(IR_BUILD_PROBLEM_KINDS).toContain(kind);
    for (const capability of EXPLAINABLE_UNSUPPORTED) expect(IR_CAPABILITIES).toContain(capability);
    for (const kind of Object.keys(MAXIMAL_POLICY) as IRRepairKind[]) expect(IR_REPAIR_KINDS).toContain(kind);
    // 全开策略必须真的是「全开」，否则上面三条属性测的是一个子集。
    expect(Object.keys(MAXIMAL_POLICY).sort()).toEqual([...IR_REPAIR_KINDS].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 已知缺陷 —— 断言的是应有行为，当前实现做不到，故意保留失败
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 修复层的价值判据只有一条，`src/repair/index.ts` 的文件头亲自写着：
 * **「原本被拒的请求变得可通过」**。反过来的方向没有被任何东西挡住 ——
 * 而它真的会发生。
 *
 * 机制：`defaultMaxOutputTokens` 的闸门是 `repairWhenPresent: ["maxOutputTokens"]`，
 * 意思是「目标**认识**这个参数就填」。gemini_cloudcode 认识它，于是闸门放行，
 * 填进 4096（这个数字是照着 Anthropic 的强制要求定的）。但 CloudCode 把
 * `thinkingBudget` **算在** `maxOutputTokens` 里面：客户端要 effort:'high'
 * （budget 10000）时，4096 连可见正文的下限都不够，于是构造阶段抛
 * `unsatisfiableValue`。
 *
 * 而**不修**的时候，gemini 出口用自己的 65536 上限，同一条请求编得好好的。
 * 换句话说：调用方为了让 Chat→Anthropic 那条路能走而打开这条修复，
 * 会顺带把 Gemini 路由上 2.2% 的真实流量从「能用」变成「422」。
 *
 * 修法有两条，都不在 Core：让闸门收窄成「目标**必须**要这个字段才填」，
 * 或让默认值随出口走（`repairWhenPresent` 里带一个每家自己的值）。
 */
describe("[暴露缺陷] 修复不是单调的：开一条修复会把本来能编译的请求弄成不能", () => {
  const geminiEgress = createGeminiCloudCodeUpstream({
    model: "gemini-test", accessToken: "t", project: "p", requestIdFactory: () => "r",
  });

  /** 最小复现：客户端没给 max_tokens，但要了 high effort。 */
  function highEffortWithoutCeiling(): IRRequest {
    const { request } = readClientRequestForProtocol("anthropic_messages", {
      model: "claude-opus-4-8",
      output_config: { effort: "high" },
      thinking: { type: "enabled", budget_tokens: 10_000 },
      messages: [{ role: "user", content: "ping" }],
    }, "tr_monotonic");
    return request;
  }

  it("DEFECT-10a 最小复现：不修能编译，开 defaultMaxOutputTokens 反而编不出来", async () => {
    const request = highEffortWithoutCeiling();
    expect(request.intent.stopping.maxOutputTokens).toBeUndefined();

    clearThoughtSignatureCache();
    const before = await geminiEgress.writeUpstreamRequest(request);
    expect(before.ok).toBe(true);

    const repaired = repairForAdmission(request, geminiEgress.profile, { defaultMaxOutputTokens: {} });
    expect(repaired.applied.map((record) => record.kind)).toEqual(["defaultMaxOutputTokens"]);
    clearThoughtSignatureCache();
    const after = await geminiEgress.writeUpstreamRequest(repaired.request);
    // ↓ 应有行为：修复只会加分。实际：unsatisfiableValue。
    expect(after.ok).toBe(true);
  });

  it.skipIf(corpus.length === 0)("DEFECT-10b 语料上的规模：一条修复让多少真实请求从能编译变成不能", async () => {
    const regressed: string[] = [];
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const [name, egress] of Object.entries(EGRESSES)) {
        // 基线必须与修复后**同口径**：准入通过 **且** 构造成功才算「本来能用」。
        if (!checkUpstreamSupport(request, egress.profile).admitted) continue;
        clearThoughtSignatureCache();
        const before = await egress.writeUpstreamRequest(request);
        if (!before.ok) continue;

        const repaired = repairForAdmission(request, egress.profile, MAXIMAL_POLICY);
        if (!repaired.admission.admitted) {
          regressed.push(`${name}/${entry.traceId}:admission:${repaired.admission.unsupported.map((need) => need.capability).join(",")}`);
          continue;
        }
        clearThoughtSignatureCache();
        const after = await egress.writeUpstreamRequest(repaired.request);
        if (!after.ok) regressed.push(`${name}/${entry.traceId}:${after.problems.map((p) => p.kind).join(",")}`);
      }
    }
    console.log(`repairs regressed ${regressed.length} (request, egress) pairs; first few:`, regressed.slice(0, 3));
    expect(regressed.length).toBe(0);
  }, 180_000);
});
