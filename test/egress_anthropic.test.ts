/**
 * Anthropic Messages 出口的 lower —— **编译或拒绝**。
 *
 * 这个文件盯的是一条分界线：
 *   位置重排、空结果补最小合法值、上游必拒的块丢弃 → wire 事实，留在 Core；
 *   历史缺一条结果、客户端没给 max_tokens        → 「我替你决定」，Core 一律带精确路径拒绝。
 *
 * IR 一律由入口 decode 真实请求体得到，不手搓 —— 手搓的 IR 只能验证我对自己的假设。
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicUpstream } from "../src/egress/anthropic.ts";
import { readAnthropicMessagesRequest, readChatCompletionsRequest } from "../src/ingress/index.ts";
import type { IRBuildProblem, IRRequest, UpstreamRequestBuildResult } from "../src/ir/types.ts";

const TRACE = "tr-anthropic";

const egress = createAnthropicUpstream({
  baseUrl: "https://api.anthropic.com/",
  apiKey: "sk-ant-test",
  model: "claude-opus-5-upstream",
});

function ok(result: UpstreamRequestBuildResult): { url: string; headers: Record<string, string>; body: string } {
  if (!result.ok) throw new Error(`expected ok:true, got problems: ${JSON.stringify(result.problems)}`);
  return { url: result.wire.url, headers: { ...result.wire.headers }, body: result.wire.body };
}

function rejected(result: UpstreamRequestBuildResult): readonly IRBuildProblem[] {
  if (result.ok) throw new Error(`expected ok:false, got body: ${result.wire.body}`);
  return result.problems;
}

function bodyOf(result: UpstreamRequestBuildResult): Record<string, unknown> {
  return JSON.parse(ok(result).body) as Record<string, unknown>;
}

function messagesOf(result: UpstreamRequestBuildResult): Array<Record<string, unknown>> {
  return bodyOf(result).messages as Array<Record<string, unknown>>;
}

function contentOf(message: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return (message?.content ?? []) as Array<Record<string, unknown>>;
}

/** 一次完整的 Claude Code 形态请求：system + 多轮 + 并行工具调用 + 工具结果 + 采样参数。 */
function fullRequest(): IRRequest {
  return readAnthropicMessagesRequest({
    model: "claude-opus-5",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "you are a gateway", cache_control: { type: "ephemeral" } }],
    temperature: 0.3,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ["</done>"],
    thinking: { type: "enabled", budget_tokens: 2048 },
    tool_choice: { type: "auto" },
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "and also this" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "b-content" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "a-content" },
        ],
      },
    ],
  }, TRACE).request;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("lower：编译成功的形状", () => {
  it("wire 逐字段：url / headers / body 全部由 IR 与 options 确定，没有第三方来源", async () => {
    const wire = ok(await egress.writeUpstreamRequest(fullRequest()));

    expect(wire.url).toBe("https://api.anthropic.com/v1/messages");
    expect(wire.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });

    const body = JSON.parse(wire.body) as Record<string, unknown>;
    // model 取 options，不是客户端说的那个：映射由调用方决定，出口不猜。
    expect(body.model).toBe("claude-opus-5-upstream");
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.3);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
    expect(body.stop_sequences).toEqual(["</done>"]);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.tools).toEqual([
      { name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } },
    ]);
    expect(body.system).toEqual([
      { type: "text", text: "you are a gateway", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("工具结果按调用顺序重铺到紧随的 user 回合最前 —— [text, tool_result] 顺序上游必拒", async () => {
    const messages = messagesOf(await egress.writeUpstreamRequest(fullRequest()));

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const last = contentOf(messages[2]);
    // 客户端送来的顺序是 [text, result(toolu_2), result(toolu_1)]；
    // 出口按 assistant 的**调用顺序** toolu_1 → toolu_2 重铺，且整体排在 text 之前。
    expect(last.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(last.map((block) => block.tool_use_id)).toEqual(["toolu_1", "toolu_2", undefined]);
    expect(last[0]?.content).toEqual([{ type: "text", text: "a-content" }]);
  });

  it("空工具结果补最小合法值 \"\" —— Anthropic 编码不出「空内容数组」，这是编译事实不是策略", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [] }] },
      ],
    }, TRACE);
    const result = await egress.writeUpstreamRequest(request);
    expect(contentOf(messagesOf(result)[1])[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "" });
  });

  it("空 text 块与无 signature 的 thinking 块被丢弃 —— 两者都是上游必拒的形状", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "real" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "no signature here" }, { type: "text", text: "answer" }] },
      ],
    }, TRACE);
    const result = await egress.writeUpstreamRequest(request);
    expect(contentOf(messagesOf(result)[0])).toEqual([{ type: "text", text: "real" }]);
    expect(contentOf(messagesOf(result)[1])).toEqual([{ type: "text", text: "answer" }]);
    if (result.ok) {
      expect(result.losses.map((loss) => loss.kind)).toEqual(["dropped"]);
      expect(result.losses[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    }
  });

  it("确定性：同一个 IR 连续构造两次，wire 字节完全相同", async () => {
    const request = fullRequest();
    const first = ok(await egress.writeUpstreamRequest(request));
    const second = ok(await egress.writeUpstreamRequest(request));
    expect(second.body).toBe(first.body);
    expect(second).toEqual(first);
    // 两个独立 decode 出来的等价 IR 也必须编译成同一份字节，构造过程不许夹带任何外部状态。
    const third = ok(await egress.writeUpstreamRequest(fullRequest()));
    expect(third.body).toBe(first.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lower：拒绝而不是发明内容", () => {
  it("客户端没给 max_tokens：拒绝，不再替他补 4096", async () => {
    // 真实来源：Chat Completions 客户端普遍不带 max_tokens，转发到 Anthropic 时才暴露这个洞。
    const { request } = readChatCompletionsRequest({
      model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(request.intent.stopping.maxOutputTokens).toBeUndefined();

    const result = await egress.writeUpstreamRequest(request);
    const problems = rejected(result);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.intent.stopping.maxOutputTokens");
    expect(problems[0]?.detail).toContain("max_tokens");
    // 拒绝就是拒绝：没有 wire 可用，调用方不可能不小心发出去一个非法 body。
    expect("wire" in result).toBe(false);
  });

  it("悬空工具调用：拒绝，并把路径指到那个 toolCall part", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_missing", name: "Bash", input: {} }] },
      ],
    }, TRACE);
    const problems = rejected(await egress.writeUpstreamRequest(request));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("danglingToolCall");
    expect(problems[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(problems[0]?.detail).toContain("toolu_missing");
  });

  it("孤儿工具结果：拒绝，并把路径指到那个 toolResult part", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: [
          { type: "text", text: "resuming" },
          { type: "tool_result", tool_use_id: "toolu_orphan", content: "leftover" },
        ] },
      ],
    }, TRACE);
    const problems = rejected(await egress.writeUpstreamRequest(request));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("orphanToolResult");
    expect(problems[0]?.path).toBe("$.conversation.turns[0].parts[1]");
    expect(problems[0]?.detail).toContain("toolu_orphan");
  });

  it("多个问题一次收集齐，不在第一个就短路 —— 调用方一次看全才能一次修完", async () => {
    const { request } = readAnthropicMessagesRequest({
      // max_tokens 缺席 + 两个悬空调用 + 一个孤儿结果，四个洞在同一条请求里
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "tool_use", id: "toolu_a", name: "Bash", input: {} },
          { type: "tool_use", id: "toolu_b", name: "Bash", input: {} },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "x" }] },
      ],
    }, TRACE);
    const problems = rejected(await egress.writeUpstreamRequest(request));

    expect(problems).toHaveLength(4);
    expect(problems.map((problem) => `${problem.kind}@${problem.path}`)).toEqual([
      "danglingToolCall@$.conversation.turns[1].parts[0]",
      "danglingToolCall@$.conversation.turns[1].parts[1]",
      "orphanToolResult@$.conversation.turns[2].parts[0]",
      "requiredFieldMissing@$.intent.stopping.maxOutputTokens",
    ]);
  });

  it("拒绝时已经攒下的 loss 一并交出，不因为拒绝就丢掉留痕", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] },
      ],
    }, TRACE);
    const result = await egress.writeUpstreamRequest(request);
    expect(result.ok).toBe(false);
    expect(result.losses.map((loss) => loss.kind)).toEqual(["dropped"]);
    expect(result.losses[0]?.stage).toBe("egress");
    expect(result.losses[0]?.provider).toBe("anthropic");
  });

  it("配齐结果之后同一形态的历史就能编译 —— 拒绝的是缺口，不是工具会话本身", async () => {
    const result = await egress.writeUpstreamRequest(fullRequest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.losses).toEqual([]);
  });
});

describe("全空会话", () => {
  it("编不出任何内容时拒绝，而不是静默产出 messages: [] 让上游 400", async () => {
    // 剥离 dropEmptyTurns 之后空回合会活到 egress，这条路径因此变常见。
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: "" }, { role: "assistant", content: [] }],
    }, "tr-empty");
    const built = await createAnthropicUpstream({
      baseUrl: "https://example.invalid", apiKey: "k", model: "claude-opus-5",
    }).writeUpstreamRequest(request);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems).toContainEqual(expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.conversation.turns",
    }));
  });
});
