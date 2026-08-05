/**
 * 拒绝理由（`IRBuildProblemKind`）的**枚举闸门**。
 *
 * 为什么要单独一个文件：`IR_BUILD_PROBLEM_KINDS` 是常量数组派生出的类型，但全仓库
 * **没有任何一处对它做穷举**（`src/server.ts` 只是把 `problem.kind` 当字符串透传给
 * 客户端）。也就是说，往那个数组里加一档，`tsc` 一声不吭 —— 新的 kind 可以一辈子
 * 没有出口产出它，也可以有出口产出了却没人知道。这正是「silent mirror」：
 * 定义在一处，事实在另一处，两边漂了没有任何东西会报错。
 *
 * 这个文件就是那个缺失的机械闸门，一次锁两件事：
 *   1. **编译期**：下面的表 `satisfies Record<IRBuildProblemKind, ProblemCase>`，
 *      新增一档 kind 而不在这里表态 → `tsc --noEmit` 报 missing property。
 *   2. **运行期**：每一档都真的跑一遍对应出口，断言它确实被产出，且 path 精确到
 *      IR 位置、detail 说得出「是哪个值」。表里写了但没人产出 → 测试红。
 *
 * 逐档的完整行为断言仍在各自的 `egress_*.test.ts` 里，这里只锁**存在性与身份**，
 * 不复制那些断言。
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicOutbox } from "../src/egress/anthropic.ts";
import { createGeminiCloudCodeOutbox } from "../src/egress/gemini_cloudcode.ts";
import { createOpenAIResponsesOutbox } from "../src/egress/openai_responses.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { IR_BUILD_PROBLEM_KINDS, clientValue, defaultValue } from "../src/ir/types.ts";
import type {
  IRBuildProblemKind, IROutbox, IRIntent, IRRequest, IRTurn, IRWireBody,
} from "../src/ir/types.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const anthropic = createAnthropicOutbox({
  baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "claude-test",
});
const responses = createOpenAIResponsesOutbox({
  baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "gpt-test",
});
const gemini = createGeminiCloudCodeOutbox({
  model: "gemini-3.6-flash-high",
  accessToken: "ya29.test-token",
  project: "default-cli-project",
  sessionId: "1785856733829",
  requestIdFactory: () => "agent/1785856733829/1785856733829/deadbeef/2",
});

function intent(overrides: Partial<IRIntent> = {}): IRIntent {
  return {
    reasoning: defaultValue({ mode: "adaptive", display: "summarized" }),
    outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"),
    sampling: {},
    stopping: { maxOutputTokens: clientValue(1024) },
    contextEdits: [],
    stream: clientValue(true),
    identity: {},
    ...overrides,
  };
}

function request(turns: readonly IRTurn[], over: Partial<IRIntent> = {}): IRRequest {
  const base = {
    traceId: "tr_problem_kinds",
    protocol: "anthropic_messages" as const,
    model: "claude-opus-4-6",
    conversation: {
      system: [],
      turns,
      toolset: {
        tools: [],
        groups: [],
        choice: defaultValue({ kind: "auto" as const }),
        parallel: defaultValue(true),
      },
    },
    intent: intent(over),
  };
  return { ...base, requires: deriveCapabilityNeeds(base) };
}

interface ProblemCase {
  /** 哪个出口在什么情形下产出这一档。 */
  readonly why: string;
  readonly outbox: IROutbox<IRWireBody>;
  readonly request: IRRequest;
  /** 期望的 IR 路径 —— 拒绝的价值全在于「是哪个字段」。 */
  readonly path: string;
  /** detail 里必须出现的定位信息（涉事的 id 或值）。 */
  readonly detailContains: string;
}

const TEXT_TURN: IRTurn = { role: "user", parts: [{ kind: "text", text: "go" }] };

/**
 * 每一档 kind 恰好一个最小复现。`satisfies` 是编译期闸门：
 * 往 `IR_BUILD_PROBLEM_KINDS` 加一档而不在这里给出复现，`tsc` 立刻报 missing property。
 */
const CASES = {
  /** 目标 wire 强制要求，而 IR 里**没有**这个值。 */
  requiredFieldMissing: {
    why: "Anthropic 必填 max_tokens，客户端一个都没给（网关不替它发明默认值）",
    outbox: anthropic,
    request: request([TEXT_TURN], { stopping: {} }),
    path: "$.intent.stopping.maxOutputTokens",
    detailContains: "max_tokens",
  },

  /**
   * IR 里**有**这个值，无解的是它与另一个字段的组合 —— 与上一档的分界只有「缺不缺」。
   * CloudCode 把 thinkingBudget 算进 maxOutputTokens：两个字段各自都合法。
   */
  unsatisfiableValue: {
    why: "CloudCode 的 maxOutputTokens 含 thinkingBudget，客户端的 20 装不下 10000 的预算",
    outbox: gemini,
    request: request([TEXT_TURN], {
      reasoning: clientValue({ mode: "enabled", budgetTokens: 10000, display: "summarized" }),
      stopping: { maxOutputTokens: clientValue(20) },
    }),
    path: "$.intent.stopping.maxOutputTokens",
    detailContains: "thinkingBudget(10000)",
  },

  danglingToolCall: {
    why: "声明了 tool_use 却没有对应结果，Anthropic 不接受悬空",
    outbox: anthropic,
    request: request([
      TEXT_TURN,
      { role: "assistant", parts: [{
        kind: "toolCall",
        call: { id: "toolu_dangling", toolRef: { group: null, name: "bash" }, input: { kind: "json", value: {} } },
      }] },
    ]),
    path: "$.conversation.turns[1].parts[0]",
    detailContains: "toolu_dangling",
  },

  orphanToolResult: {
    why: "工具结果找不到发起它的调用",
    outbox: anthropic,
    request: request([
      { role: "user", parts: [{
        kind: "toolResult",
        result: { callId: "toolu_orphan", parts: [{ kind: "text", text: "x" }], status: "ok" },
      }] },
    ]),
    path: "$.conversation.turns[0].parts[0]",
    detailContains: "toolu_orphan",
  },

  unrepresentablePart: {
    why: "/v1/responses 没有实证过的 document 载体，网关不拿一句转述顶替正文",
    outbox: responses,
    request: request([
      { role: "user", parts: [{
        kind: "document",
        media: { source: { kind: "base64", data: "JVBERi0=" }, mediaType: "application/pdf" },
      }] },
    ]),
    path: "$.conversation.turns[0].parts[0]",
    detailContains: "application/pdf",
  },
} satisfies Record<IRBuildProblemKind, ProblemCase>;

// ── 断言 ────────────────────────────────────────────────────────────────────

describe("IRBuildProblemKind 的枚举闸门", () => {
  // 清单从唯一授权定义取，不在测试里手抄第二份 —— 手抄的那份改了源不会失败，
  // 它只会一起沉默，把「每一档都有出口产出」变成一句没人验证的话。
  it("表里没有多余的档，也没有漏掉的档", () => {
    expect(Object.keys(CASES).sort()).toEqual([...IR_BUILD_PROBLEM_KINDS].sort());
  });

  for (const kind of IR_BUILD_PROBLEM_KINDS) {
    const problemCase: ProblemCase = CASES[kind];
    it(`${kind}：${problemCase.why}`, async () => {
      const built = await problemCase.outbox.writeOutboxRequest(problemCase.request);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      const found = built.problems.find((problem) => problem.kind === kind);
      expect(found).toBeDefined();
      expect(found?.path).toBe(problemCase.path);
      expect(found?.detail).toContain(problemCase.detailContains);
    });
  }

  /**
   * 分界线本身也要有测例：同一个「值不合适」的场景，缺值与值冲突必须落到**不同**的 kind。
   * 分错了 kind，调用方会被指去补一个它已经有的值。
   */
  it("缺值 vs 值冲突：两者不共用一档 kind", async () => {
    const missing = await anthropic.writeOutboxRequest(CASES.requiredFieldMissing.request);
    const unsatisfiable = await gemini.writeOutboxRequest(CASES.unsatisfiableValue.request);
    expect(missing.ok).toBe(false);
    expect(unsatisfiable.ok).toBe(false);
    if (missing.ok || unsatisfiable.ok) return;

    // 两条都指向 maxOutputTokens 这同一个 IR 路径，区别只在 kind
    expect(missing.problems.map((problem) => problem.kind)).toEqual(["requiredFieldMissing"]);
    expect(unsatisfiable.problems.map((problem) => problem.kind)).toEqual(["unsatisfiableValue"]);
    expect(missing.problems[0]?.path).toBe(unsatisfiable.problems[0]?.path);
  });
});
