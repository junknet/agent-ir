/**
 * 入口畸形输入 —— 三个协议各一组。
 *
 * 判据**不是「不崩」**，是行为可预测，只有两种合法结局：
 *   1. 产出自洽的 IR，并且每一处「客户端说了但没进 IR」的地方都有一条 `IRLoss`；
 *   2. 抛一个明确类型的错误（`TypeError`）。
 *
 * 「静默产出半个 IR」——即输入里有内容、IR 里没有、losses 里也没有——是最严重的失败，
 * 因为它在下游表现为「模型好像没看到我说的话」，没有任何一处日志能指认。
 * 因此本文件的每条用例都同时断言 IR 形状**与** losses，不允许只看其中一个。
 *
 * 报文形状取自 `.corpus/requests.ndjson` 的真实键集，破坏方式取自真实客户端会犯的错：
 * SDK 把 `content` 序列化成数字、代理把 `messages` 包了一层、重放工具历史时 id 撞车。
 */
import { describe, expect, it } from "bun:test";
import { readAnthropicMessagesRequest } from "../src/ingress/anthropic_messages.ts";
import { readChatCompletionsRequest } from "../src/ingress/openai_chat_completions.ts";
import { readResponsesRequest } from "../src/ingress/openai_responses.ts";
import { IR_LOSS_KINDS, IR_PROTOCOLS } from "../src/ir/types.ts";
import type { ClientRequestReadResult, IRPart, IRProtocol, IRRequest } from "../src/ir/types.ts";

// ── 共用工具 ────────────────────────────────────────────────────────────────

type Reader = (raw: unknown, traceId: string) => ClientRequestReadResult;

const READERS: Readonly<Record<IRProtocol, Reader>> = {
  anthropic_messages: readAnthropicMessagesRequest,
  openai_chat_completions: readChatCompletionsRequest,
  openai_responses: readResponsesRequest,
};

/** 一段最小的、三个协议都表达得了的「用户说了一句话」。用来做破坏实验的对照组。 */
const MINIMAL: Readonly<Record<IRProtocol, Record<string, unknown>>> = {
  anthropic_messages: {
    model: "claude-opus-4-8", max_tokens: 64,
    messages: [{ role: "user", content: "ping" }],
  },
  openai_chat_completions: {
    model: "gpt-5.2", messages: [{ role: "user", content: "ping" }],
  },
  openai_responses: {
    model: "gpt-5.2", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
  },
};

function walk(parts: readonly IRPart[], visit: (part: IRPart) => void): void {
  for (const part of parts) {
    visit(part);
    if (part.kind === "toolResult") walk(part.result.parts, visit);
  }
}

function allParts(request: IRRequest): IRPart[] {
  const out: IRPart[] = [];
  walk(request.conversation.system, (part) => out.push(part));
  for (const turn of request.conversation.turns) walk(turn.parts, (part) => out.push(part));
  return out;
}

function partKinds(request: IRRequest): string[] {
  return allParts(request).map((part) => part.kind);
}

/** IR 自洽性：任何一条 decode 结果都必须满足，无论输入多畸形。 */
function expectSelfConsistent(result: ClientRequestReadResult, protocol: IRProtocol): void {
  const { request, losses } = result;
  expect(request.protocol).toBe(protocol);
  expect(typeof request.model).toBe("string");
  expect(Array.isArray(request.conversation.turns)).toBe(true);
  expect(Array.isArray(request.conversation.system)).toBe(true);
  // requires 是推导出来的，不是手写的：每一条都必须带至少一个路径，否则 422 指不到位置。
  for (const need of request.requires) {
    expect(need.paths.length).toBeGreaterThan(0);
    for (const path of need.paths) expect(path.startsWith("$")).toBe(true);
  }
  // 回合里不许出现相邻同角色（normalizeTurns 的出参不变量）。
  for (let i = 1; i < request.conversation.turns.length; i++) {
    expect(request.conversation.turns[i]!.role).not.toBe(request.conversation.turns[i - 1]!.role);
  }
  for (const loss of losses) {
    expect(loss.stage).toBe("ingress");
    expect(IR_LOSS_KINDS).toContain(loss.kind);
    expect(loss.path.startsWith("$")).toBe(true);
    expect(loss.detail.length).toBeGreaterThan(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 顶层 body
// ═══════════════════════════════════════════════════════════════════════════

describe("顶层 body 不是对象 —— 三个协议一致地抛，不产出半个 IR", () => {
  const notObjects: readonly [string, unknown][] = [
    ["null", null],
    ["数组", [{ role: "user", content: "ping" }]],
    ["字符串", "{\"messages\":[]}"],
    ["数字", 42],
    ["布尔", true],
    ["undefined", undefined],
  ];

  for (const protocol of IR_PROTOCOLS) {
    for (const [label, body] of notObjects) {
      it(`${protocol} ← ${label}`, () => {
        expect(() => READERS[protocol](body, "tr_x")).toThrow(TypeError);
      });
    }
  }
});

describe("空对象 body —— 合法但什么都没有，且不许假装有", () => {
  for (const protocol of IR_PROTOCOLS) {
    it(protocol, () => {
      const result = READERS[protocol]({}, "tr_empty");
      expectSelfConsistent(result, protocol);
      expect(result.request.conversation.turns).toEqual([]);
      expect(result.request.conversation.system).toEqual([]);
      expect(result.request.conversation.toolset.tools).toEqual([]);
      // model 缺席落成空串（decode 不发明模型名），而不是 undefined。
      expect(result.request.model).toBe("");
      // 空会话仍然要推导出 stream/nonStream 需求 —— requires 永远不是空的。
      expect(result.request.requires.length).toBeGreaterThan(0);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// messages / input 容器本身畸形
// ═══════════════════════════════════════════════════════════════════════════

describe("消息容器不是数组", () => {
  it("openai_responses / input 是裸字符串是**合法**形态，不能与畸形混为一谈", () => {
    const result = readResponsesRequest({ model: "m", input: "ping" }, "tr_str");
    expectSelfConsistent(result, "openai_responses");
    expect(result.request.conversation.turns).toEqual([
      { role: "user", parts: [{ kind: "text", text: "ping" }] },
    ]);
    expect(result.losses).toEqual([]);
  });
});

describe("单条消息不是对象", () => {
  it("anthropic：非对象消息被丢弃并留痕，其余消息照常解", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [null, "bare string", 7, { role: "user", content: "ping" }, []],
    }, "tr_m");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    expect(request.conversation.turns).toEqual([
      { role: "user", parts: [{ kind: "text", text: "ping" }] },
    ]);
    // 四条非对象消息（数组也算非 record）各留一条痕。
    expect(losses.filter((loss) => loss.detail === "non-object message")).toHaveLength(4);
  });

  it("chat：同上，路径指到具体下标", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m", messages: [null, { role: "user", content: "ping" }],
    }, "tr_m");
    expectSelfConsistent({ request, losses }, "openai_chat_completions");
    expect(request.conversation.turns).toHaveLength(1);
    expect(losses.map((loss) => loss.path)).toContain("$.messages[0]");
  });

  it("responses：非对象 item 被丢弃并留痕（裸字符串 item 除外，那是合法的 user 消息）", () => {
    const { request, losses } = readResponsesRequest({
      model: "m", input: [null, 7, "bare", { type: "message", role: "user", content: "ping" }],
    }, "tr_m");
    expectSelfConsistent({ request, losses }, "openai_responses");
    // "bare" 与那条 message 合并成一个 user 回合。
    expect(request.conversation.turns).toHaveLength(1);
    expect(request.conversation.turns[0]!.parts).toEqual([
      { kind: "text", text: "bare" },
      { kind: "text", text: "ping" },
    ]);
    expect(losses.filter((loss) => loss.detail === "non-object input item")).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// content 的畸形取值
// ═══════════════════════════════════════════════════════════════════════════

describe("content 是数字 / 布尔 / 对象 —— 必须装箱成 opaque 并留痕，绝不静默丢", () => {
  const cases: readonly [IRProtocol, unknown][] = [
    ["anthropic_messages", 42],
    ["anthropic_messages", true],
    ["anthropic_messages", { text: "ping" }],
    ["openai_chat_completions", 42],
    ["openai_chat_completions", { text: "ping" }],
    ["openai_responses", 42],
    ["openai_responses", { text: "ping" }],
  ];

  for (const [protocol, content] of cases) {
    it(`${protocol} ← ${JSON.stringify(content)}`, () => {
      const body: Record<string, unknown> =
        protocol === "openai_responses"
          ? { model: "m", input: [{ type: "message", role: "user", content }] }
          : { model: "m", max_tokens: 8, messages: [{ role: "user", content }] };
      const result = READERS[protocol](body, "tr_c");
      expectSelfConsistent(result, protocol);
      const parts = allParts(result.request);
      expect(parts).toHaveLength(1);
      expect(parts[0]!.kind).toBe("opaque");
      // 原始值原样留在 raw 里 —— 能表达它的出口可以无损还原。
      expect((parts[0] as Extract<IRPart, { kind: "opaque" }>).raw).toEqual(content);
      expect(result.losses.length).toBeGreaterThan(0);
      expect(result.losses.every((loss) => loss.kind === "substituted")).toBe(true);
    });
  }
});

describe("content 是 null / undefined / 空串 / 空数组 —— 产出空回合，不留假痕", () => {
  const empties: readonly unknown[] = [null, undefined, "", []];

  for (const protocol of IR_PROTOCOLS) {
    for (const content of empties) {
      it(`${protocol} ← ${JSON.stringify(content) ?? "undefined"}`, () => {
        const body: Record<string, unknown> =
          protocol === "openai_responses"
            ? { model: "m", input: [{ type: "message", role: "user", content }] }
            : { model: "m", max_tokens: 8, messages: [{ role: "user", content }] };
        const result = READERS[protocol](body, "tr_e");
        expectSelfConsistent(result, protocol);
        expect(result.request.conversation.turns).toEqual([{ role: "user", parts: [] }]);
        // 空就是空：客户端没说话，没有任何东西被丢，所以不许记 loss。
        expect(result.losses).toEqual([]);
      });
    }
  }
});

describe("content 数组里混着畸形块", () => {
  it("anthropic：字符串块当文本、非对象块装箱、未知 type 装箱，三种各自留痕", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "user",
        content: [
          "bare string block",
          42,
          null,
          { type: "text", text: "ok" },
          { type: "server_tool_use_2099", id: "x", name: "y" },
          { /* 没有 type */ text: "no type" },
        ],
      }],
    }, "tr_blocks");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    expect(partKinds(request)).toEqual(["text", "opaque", "opaque", "text", "opaque", "opaque"]);
    // 非对象块记 substituted，未知 type 记 degraded —— 两种成因不能共用一个类别。
    expect(losses.filter((loss) => loss.kind === "substituted")).toHaveLength(2);
    expect(losses.filter((loss) => loss.kind === "degraded")).toHaveLength(2);
    // 未知块的 tag 必须是上游原话，供出口决定要不要同源透传。
    const tags = allParts(request)
      .filter((part): part is Extract<IRPart, { kind: "opaque" }> => part.kind === "opaque")
      .map((part) => part.tag);
    expect(tags).toEqual(["non-object", "non-object", "server_tool_use_2099", "unknown"]);
  });

  it("chat：content 数组里的非对象 part 装箱留痕，image_url 缺 url 也装箱", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [42, { type: "image_url", image_url: {} }, { type: "text", text: "ok" }],
      }],
    }, "tr_c");
    expectSelfConsistent({ request, losses }, "openai_chat_completions");
    expect(partKinds(request)).toEqual(["opaque", "opaque", "text"]);
    expect(losses).toHaveLength(2);
  });

  it("responses：未知 content part 类型装箱并留 degraded", () => {
    const { request, losses } = readResponsesRequest({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_video_2099", url: "x" }] }],
    }, "tr_c");
    expectSelfConsistent({ request, losses }, "openai_responses");
    expect(partKinds(request)).toEqual(["opaque"]);
    expect(losses[0]!.kind).toBe("degraded");
  });
});

describe("未知 role", () => {
  it("anthropic：未知 role 的消息整条丢弃并留痕", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "moderator", content: "secret" }, { role: "user", content: "ping" }],
    }, "tr_r");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    expect(request.conversation.turns).toHaveLength(1);
    expect(losses.some((loss) => loss.detail.includes("unknown message role"))).toBe(true);
  });

  it("chat：同上", () => {
    const { losses } = readChatCompletionsRequest({
      model: "m", messages: [{ role: "moderator", content: "secret" }],
    }, "tr_r");
    expect(losses.some((loss) => loss.detail.includes("unknown message role"))).toBe(true);
  });

  it("responses：message item 的未知 role 落成 user —— 内容不丢（与另两个协议的丢弃不同构）", () => {
    const result = readResponsesRequest({
      model: "m", input: [{ type: "message", role: "moderator", content: "secret" }],
    }, "tr_r");
    expectSelfConsistent(result, "openai_responses");
    // Responses 的 item 没有「角色必须在册」这条约束，兜底成 user 是保内容的一侧；
    // 另外两个协议丢弃并留痕，是保语义的一侧。两种都能自圆其说，差异记在报告 OBS-1。
    expect(result.request.conversation.turns).toEqual([
      { role: "user", parts: [{ kind: "text", text: "secret" }] },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════════════════════

describe("工具定义畸形", () => {
  it("tools 数组里的非对象项被丢弃并留痕", () => {
    for (const protocol of IR_PROTOCOLS) {
      const body: Record<string, unknown> = { ...MINIMAL[protocol], tools: [null, 42, "read"] };
      const result = READERS[protocol](body, "tr_tools");
      expectSelfConsistent(result, protocol);
      expect(result.request.conversation.toolset.tools).toEqual([]);
      expect(result.losses.filter((loss) => loss.detail === "non-object tool definition")).toHaveLength(3);
    }
  });

  it("工具没有 name：丢弃并留痕，绝不用空串当名字", () => {
    const anthropic = readAnthropicMessagesRequest({
      ...MINIMAL.anthropic_messages, tools: [{ description: "d", input_schema: { type: "object" } }],
    }, "tr_n");
    expect(anthropic.request.conversation.toolset.tools).toEqual([]);
    expect(anthropic.losses.some((loss) => loss.detail === "tool definition without a name")).toBe(true);

    const chat = readChatCompletionsRequest({
      ...MINIMAL.openai_chat_completions, tools: [{ type: "function", function: { description: "d" } }],
    }, "tr_n");
    expect(chat.request.conversation.toolset.tools).toEqual([]);
    expect(chat.losses.some((loss) => loss.detail === "tool definition without a name")).toBe(true);

    const responses = readResponsesRequest({
      ...MINIMAL.openai_responses, tools: [{ type: "function", description: "d" }],
    }, "tr_n");
    expect(responses.request.conversation.toolset.tools).toEqual([]);
    expect(responses.losses.some((loss) => loss.detail === "tool definition without a name")).toBe(true);
  });

  it("input_schema / parameters 不是对象：降级成 freeform 并留痕，不硬塞一个空 schema", () => {
    const anthropic = readAnthropicMessagesRequest({
      ...MINIMAL.anthropic_messages, tools: [{ name: "read", input_schema: "a string" }],
    }, "tr_s");
    expect(anthropic.request.conversation.toolset.tools[0]!.kind).toBe("freeform");
    expect(anthropic.losses.some((loss) => loss.kind === "degraded")).toBe(true);

    const responses = readResponsesRequest({
      ...MINIMAL.openai_responses, tools: [{ type: "function", name: "read", parameters: "a string" }],
    }, "tr_s");
    expect(responses.request.conversation.toolset.tools[0]!.kind).toBe("freeform");
    expect(responses.losses.some((loss) => loss.kind === "degraded")).toBe(true);
  });

  it("同名工具重复定义：两条都保留，去重是策略不是解码事实", () => {
    const { request } = readAnthropicMessagesRequest({
      ...MINIMAL.anthropic_messages,
      tools: [
        { name: "read", input_schema: { type: "object" } },
        { name: "read", input_schema: { type: "object", properties: { p: {} } } },
      ],
    }, "tr_dup");
    expect(request.conversation.toolset.tools).toHaveLength(2);
  });

  it("tool_choice 畸形：丢弃并留痕，choice 退回 gateway-default", () => {
    for (const [protocol, choice] of [
      ["anthropic_messages", 42],
      ["anthropic_messages", { type: "whatever" }],
      ["openai_chat_completions", "whatever"],
      ["openai_chat_completions", { type: "function" }],
      ["openai_responses", "whatever"],
      ["openai_responses", { }],
    ] as const) {
      const result = READERS[protocol]({ ...MINIMAL[protocol], tool_choice: choice }, "tr_tc");
      expectSelfConsistent(result, protocol);
      expect(result.request.conversation.toolset.choice.source).toBe("gateway-default");
      expect(result.losses.some((loss) => loss.path === "$.tool_choice")).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 工具调用 / 结果的关联畸形
// ═══════════════════════════════════════════════════════════════════════════

describe("tool_call_id 重复", () => {
  it("anthropic：两条同 id 的 tool_result 都保留在 IR 里（去重不是解码的事）", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "first" },
            { type: "tool_result", tool_use_id: "call_1", content: "second" },
          ],
        },
      ],
    }, "tr_dup");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    const results = allParts(request).filter((part) => part.kind === "toolResult");
    expect(results).toHaveLength(2);
    expect(losses).toEqual([]);
  });

  it("anthropic：两条同 id 的 tool_use 也都保留", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read", input: { p: 1 } },
          { type: "tool_use", id: "call_1", name: "write", input: { p: 2 } },
        ],
      }],
    }, "tr_dup");
    const calls = allParts(request).filter((part) => part.kind === "toolCall");
    expect(calls).toHaveLength(2);
  });

  it("chat：同 id 的多条 tool 消息各自成一个 toolResult，合并进同一个 user 回合", () => {
    const { request } = readChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "first" },
        { role: "tool", tool_call_id: "call_1", content: "second" },
      ],
    }, "tr_dup");
    expect(request.conversation.turns).toHaveLength(2);
    expect(request.conversation.turns[1]!.parts).toHaveLength(2);
  });
});

describe("工具调用缺关键字段", () => {
  it("anthropic：tool_use 缺 id 或 name → 装箱成 opaque 并留痕，不造一个假 id", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: {} },
          { type: "tool_use", id: "call_2", input: {} },
        ],
      }],
    }, "tr_x");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    expect(partKinds(request)).toEqual(["opaque", "opaque"]);
    expect(losses.filter((loss) => loss.detail === "tool_use block missing id or name")).toHaveLength(2);
  });

  it("anthropic：tool_result 缺 tool_use_id → 装箱留痕（关联不上就不许假装关联上了）", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "tool_result", content: "out" }] }],
    }, "tr_x");
    expectSelfConsistent({ request, losses }, "anthropic_messages");
    expect(partKinds(request)).toEqual(["opaque"]);
    expect(losses[0]!.detail).toBe("tool_result block without tool_use_id");
  });

  it("chat：tool_calls 里缺 id/name 的项装箱留痕；arguments 不是 JSON 降级成 freeform", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m",
      messages: [{
        role: "assistant",
        tool_calls: [
          { type: "function", function: { name: "read", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "write", arguments: "not json" } },
        ],
      }],
    }, "tr_x");
    expectSelfConsistent({ request, losses }, "openai_chat_completions");
    expect(partKinds(request)).toEqual(["opaque", "toolCall"]);
    const call = allParts(request)[1] as Extract<IRPart, { kind: "toolCall" }>;
    expect(call.call.input).toEqual({ kind: "text", text: "not json" });
    expect(losses).toHaveLength(2);
  });

  it("responses：function_call 缺 call_id/name → 装箱留痕", () => {
    const { request, losses } = readResponsesRequest({
      model: "m", input: [{ type: "function_call", arguments: "{}" }],
    }, "tr_x");
    expectSelfConsistent({ request, losses }, "openai_responses");
    expect(partKinds(request)).toEqual(["opaque"]);
    expect(losses[0]!.kind).toBe("substituted");
  });

  it("responses：function_call_output 缺 call_id → 整项丢弃并留痕", () => {
    const { request, losses } = readResponsesRequest({
      model: "m", input: [{ type: "function_call_output", output: "done" }],
    }, "tr_x");
    expectSelfConsistent({ request, losses }, "openai_responses");
    expect(request.conversation.turns).toEqual([]);
    expect(losses[0]!.kind).toBe("dropped");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 规模：深嵌套与超大字段
// ═══════════════════════════════════════════════════════════════════════════

describe("深层嵌套", () => {
  /**
   * `tool_result.content` 可以再放 `tool_result` —— decodeBlock 对它是**真递归**。
   * 上游没有任何深度上限，因此深度就是攻击面：栈溢出在 Bun 里是 RangeError，
   * 它既不是 TypeError 也不是判别联合，调用方无从预期。
   */
  function nestedToolResult(depth: number): Record<string, unknown> {
    let block: Record<string, unknown> = { type: "text", text: "leaf" };
    for (let i = 0; i < depth; i++) {
      block = { type: "tool_result", tool_use_id: `call_${i}`, content: [block] };
    }
    return block;
  }

  it("深度 64 的嵌套 tool_result 正常解出，叶子内容不丢", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: [nestedToolResult(64)] }],
    }, "tr_deep");
    const kinds = partKinds(request);
    expect(kinds.filter((kind) => kind === "toolResult")).toHaveLength(64);
    expect(kinds[kinds.length - 1]).toBe("text");
  });

  it("深度 20000 的嵌套触发栈溢出 —— 抛的是 RangeError，不是 TypeError", () => {
    let thrown: unknown = null;
    try {
      readAnthropicMessagesRequest({
        model: "m", max_tokens: 8,
        messages: [{ role: "user", content: [nestedToolResult(20_000)] }],
      }, "tr_deep");
    } catch (error) { thrown = error; }
    // 现状：入口对递归深度不设限，畸形深度以 RangeError 逃逸。见报告 DEFECT-5。
    expect(thrown).toBeInstanceOf(RangeError);
  });

  it("深层 JSON schema（500 层）不递归，原样带走", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 500; i++) schema = { type: "object", properties: { child: schema } };
    const { request } = readAnthropicMessagesRequest({
      ...MINIMAL.anthropic_messages, tools: [{ name: "deep", input_schema: schema }],
    }, "tr_schema");
    const tool = request.conversation.toolset.tools[0]!;
    expect(tool.kind).toBe("function");
    if (tool.kind === "function") expect(tool.schema).toBe(schema);
  });
});

describe("超大字段", () => {
  const HUGE = "x".repeat(2_000_000);

  it("2MB 文本原样保留，不截断也不记 truncated", () => {
    for (const protocol of IR_PROTOCOLS) {
      const body: Record<string, unknown> =
        protocol === "openai_responses"
          ? { model: "m", input: [{ type: "message", role: "user", content: HUGE }] }
          : { model: "m", max_tokens: 8, messages: [{ role: "user", content: HUGE }] };
      const result = READERS[protocol](body, "tr_huge");
      const part = allParts(result.request)[0]!;
      expect(part.kind).toBe("text");
      if (part.kind === "text") expect(part.text.length).toBe(HUGE.length);
      expect(result.losses).toEqual([]);
    }
  });

  it("2 万个 part 的单条消息全部保留，且 requires 的路径被截到上限（8 条）", () => {
    const content = Array.from({ length: 20_000 }, (_, i) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `d${i}` } }));
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content }],
    }, "tr_many");
    expect(request.conversation.turns[0]!.parts).toHaveLength(20_000);
    const image = request.requires.find((need) => need.capability === "image");
    expect(image).toBeDefined();
    // 需求是布尔的，路径只为指位置；全留会让深层会话产生上万条。
    expect(image!.paths.length).toBeLessThanOrEqual(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 未知字段
// ═══════════════════════════════════════════════════════════════════════════

describe("未知顶层字段", () => {
  it("三个协议都忽略不认识的顶层字段，且不因此报错或留痕", () => {
    for (const protocol of IR_PROTOCOLS) {
      const result = READERS[protocol]({
        ...MINIMAL[protocol],
        future_field_2099: { anything: [1, 2, 3] },
        __proto__unrelated: "x",
      }, "tr_unknown");
      expectSelfConsistent(result, protocol);
      expect(result.request.conversation.turns.length).toBeGreaterThan(0);
      expect(result.losses).toEqual([]);
    }
  });

  it("原型污染形状的键不会改变 IR 的原型链", () => {
    const body = JSON.parse('{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"ping"}],"__proto__":{"polluted":true}}') as unknown;
    const { request } = readAnthropicMessagesRequest(body, "tr_proto");
    expect((request as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 数值字段的畸形取值
// ═══════════════════════════════════════════════════════════════════════════

describe("数值字段畸形", () => {
  const bad: readonly unknown[] = ["4096", NaN, Infinity, -Infinity, null, {}, []];

  it("max_tokens 非有限数一律当作缺席（不 NaN 化，也不字符串化）", () => {
    for (const value of bad) {
      const { request } = readAnthropicMessagesRequest({
        model: "m", max_tokens: value, messages: [{ role: "user", content: "ping" }],
      }, "tr_n");
      expect(request.intent.stopping.maxOutputTokens).toBeUndefined();
    }
  });

  it("temperature / top_p / top_k 同上", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, temperature: "hot", top_p: NaN, top_k: null,
      messages: [{ role: "user", content: "ping" }],
    }, "tr_n");
    expect(request.intent.sampling).toEqual({});
  });

  it("负数与 0 是合法取值，照收不误 —— 取值范围裁决属于上游", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 0, temperature: -1, messages: [{ role: "user", content: "ping" }],
    }, "tr_n");
    expect(request.intent.stopping.maxOutputTokens?.value).toBe(0);
    expect(request.intent.sampling.temperature?.value).toBe(-1);
  });

  it("model 不是字符串时落成空串，绝不 String() 化一个对象", () => {
    for (const value of [42, null, {}, []]) {
      const { request } = readAnthropicMessagesRequest({
        model: value, max_tokens: 8, messages: [{ role: "user", content: "ping" }],
      }, "tr_n");
      expect(request.model).toBe("");
    }
  });

  it("未知 effort 档变成 undefined（档位是封闭集，不猜）—— 是否该留痕见报告 OBS-2", () => {
    const { request } = readChatCompletionsRequest({
      model: "m", reasoning_effort: "ultra", messages: [{ role: "user", content: "ping" }],
    }, "tr_n");
    expect(request.intent.reasoning.value.effort).toBeUndefined();
    expect(request.intent.reasoning.source).toBe("gateway-default");
  });

  it("stop_sequences 里的非字符串项被过滤掉，其余保留", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, stop_sequences: ["a", 42, null, "b"],
      messages: [{ role: "user", content: "ping" }],
    }, "tr_n");
    expect(request.intent.stopping.stopSequences?.value).toEqual(["a", "b"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 已知缺陷 —— 以下用例断言的是**应有行为**，当前实现做不到，故意保留失败
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一条规则，六个站点：**客户端说了、IR 里没有，就必须有一条 `IRLoss`**（`types.ts` 不变量 3）。
 *
 * 当前这六处的写法都是「形状不对就换成空值」——`Array.isArray(x) ? x : []`、
 * `asString(x) ?? ""`、`isRecord(x) ? x : {}`。空值本身没错，错在**同时不留痕**：
 * 于是「客户端根本没说」与「客户端说了但我没读懂」在下游完全不可区分，
 * 而这两者的处置截然不同（前者继续，后者应当告诉客户端他的报文有问题）。
 *
 * 这些用例不是写错了，是**在暴露缺陷**。修法都是一行：在 `?? 默认值` 的那条分支上
 * `losses.record({...})`。修好之后它们会自己变绿。
 */
describe("[暴露缺陷] 形状不对时换成空值，但必须留痕", () => {
  it("DEFECT-1a anthropic：messages 不是数组 → 整段会话消失，应记一条 loss", () => {
    const { losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: { role: "user", content: "ping" },
    }, "tr_d1");
    expect(losses.length).toBeGreaterThan(0);
  });

  it("DEFECT-1b chat：messages 不是数组 → 同上", () => {
    const { losses } = readChatCompletionsRequest({
      model: "m", messages: { role: "user", content: "ping" },
    }, "tr_d1");
    expect(losses.length).toBeGreaterThan(0);
  });

  it("DEFECT-1c responses：input 既不是数组也不是字符串 → 同上", () => {
    const { losses } = readResponsesRequest({
      model: "m", input: { type: "message", role: "user", content: "ping" },
    }, "tr_d1");
    expect(losses.length).toBeGreaterThan(0);
  });

  it("DEFECT-1d 三个协议：tools 不是数组 → 整个工具集消失，应记一条 loss", () => {
    for (const protocol of IR_PROTOCOLS) {
      const { losses } = READERS[protocol]({ ...MINIMAL[protocol], tools: { name: "read" } }, "tr_d1");
      expect(losses.length).toBeGreaterThan(0);
    }
  });

  it("DEFECT-1e chat：tool_calls 不是数组 → 整段工具调用消失，应记一条 loss", () => {
    const { losses } = readChatCompletionsRequest({
      model: "m", messages: [{ role: "assistant", content: "", tool_calls: { id: "call_1" } }],
    }, "tr_d1");
    expect(losses.length).toBeGreaterThan(0);
  });

  it("DEFECT-2 anthropic：text 块的 text 不是字符串 → 内容被换成 \"\"，应记一条 loss", () => {
    const { losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: 42 }] }],
    }, "tr_d2");
    expect(losses.length).toBeGreaterThan(0);
  });

  it("DEFECT-3 chat：function.parameters 不是对象 → 降级成 freeform，应像另两个协议一样记 degraded", () => {
    const { losses } = readChatCompletionsRequest({
      ...MINIMAL.openai_chat_completions,
      tools: [{ type: "function", function: { name: "read", parameters: "a string" } }],
    }, "tr_d3");
    expect(losses.some((loss) => loss.kind === "degraded")).toBe(true);
  });

  it("DEFECT-4 anthropic：tool_use.input 不是对象 → 参数被换成 {}，应记一条 loss", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: "{\"path\":\"/etc/passwd\"}" }],
      }],
    }, "tr_d4");
    const call = allParts(request)[0] as Extract<IRPart, { kind: "toolCall" }>;
    expect(call.call.input).toEqual({ kind: "json", value: {} });
    expect(losses.length).toBeGreaterThan(0);
  });
});
