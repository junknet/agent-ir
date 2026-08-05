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
import { createAnthropicOutbox } from "../src/outbox/anthropic.ts";
import { createOpenAIChatOutbox } from "../src/outbox/openai_chat_completions.ts";
import { createOpenAIResponsesOutbox } from "../src/outbox/openai_responses.ts";
import { readAnthropicMessagesRequest, readChatCompletionsRequest } from "../src/inbox/index.ts";
import { assembleResponse } from "../src/ir/response.ts";
import type { IRBuildProblem, IRRequest, OutboxRequestBuildResult } from "../src/ir/types.ts";

const TRACE = "tr-anthropic";

const outbox = createAnthropicOutbox({
  baseUrl: "https://api.anthropic.com/",
  apiKey: "sk-ant-test",
  model: "claude-opus-5-upstream",
});

function ok(result: OutboxRequestBuildResult): { url: string; headers: Record<string, string>; body: string } {
  if (!result.ok) throw new Error(`expected ok:true, got problems: ${JSON.stringify(result.problems)}`);
  return { url: result.wire.url, headers: { ...result.wire.headers }, body: result.wire.body };
}

function rejected(result: OutboxRequestBuildResult): readonly IRBuildProblem[] {
  if (result.ok) throw new Error(`expected ok:false, got body: ${result.wire.body}`);
  return result.problems;
}

function bodyOf(result: OutboxRequestBuildResult): Record<string, unknown> {
  return JSON.parse(ok(result).body) as Record<string, unknown>;
}

function messagesOf(result: OutboxRequestBuildResult): Array<Record<string, unknown>> {
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
    const wire = ok(await outbox.writeOutboxRequest(fullRequest()));

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
    const messages = messagesOf(await outbox.writeOutboxRequest(fullRequest()));

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
    const result = await outbox.writeOutboxRequest(request);
    expect(contentOf(messagesOf(result)[1])[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "" });
  });

  it("空 text 块与无 signature 的 thinking 块被丢弃 —— 两者都是上游必拒的形状", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }, { type: "text", text: "real" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "no signature here" }, { type: "text", text: "answer" }] },
      ],
    }, TRACE);
    const result = await outbox.writeOutboxRequest(request);
    expect(contentOf(messagesOf(result)[0])).toEqual([{ type: "text", text: "real" }]);
    expect(contentOf(messagesOf(result)[1])).toEqual([{ type: "text", text: "answer" }]);
    if (result.ok) {
      expect(result.losses.map((loss) => loss.kind)).toEqual(["dropped", "dropped"]);
      expect(result.losses.map((loss) => loss.path)).toEqual([
        "$.conversation.turns[0].parts[0]",
        "$.conversation.turns[1].parts[0]",
      ]);
      expect(result.losses[0]?.detail).toContain("cache breakpoint");
    }
  });

  it("确定性：同一个 IR 连续构造两次，wire 字节完全相同", async () => {
    const request = fullRequest();
    const first = ok(await outbox.writeOutboxRequest(request));
    const second = ok(await outbox.writeOutboxRequest(request));
    expect(second.body).toBe(first.body);
    expect(second).toEqual(first);
    // 两个独立 decode 出来的等价 IR 也必须编译成同一份字节，构造过程不许夹带任何外部状态。
    const third = ok(await outbox.writeOutboxRequest(fullRequest()));
    expect(third.body).toBe(first.body);
  });

  it("抓包组合形态：图片与两轮并行工具调用/结果在同一请求中全部保留", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "claude", max_tokens: 512, stream: true,
      tools: [
        { name: "Read", description: "read", input_schema: { type: "object" } },
        { name: "Search", description: "search", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "text", text: "inspect this image" },
        ] },
        { role: "assistant", content: [
          { type: "tool_use", id: "toolu_read", name: "Read", input: { path: "first.txt" } },
          { type: "tool_use", id: "toolu_search", name: "Search", input: { query: "image" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_search", content: "search result" },
          { type: "tool_result", tool_use_id: "toolu_read", content: "file content" },
        ] },
        { role: "assistant", content: [
          { type: "tool_use", id: "toolu_read_second", name: "Read", input: { path: "second.txt" } },
          { type: "tool_use", id: "toolu_search_second", name: "Search", input: { query: "follow up" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_search_second", content: "second search" },
          { type: "tool_result", tool_use_id: "toolu_read_second", content: "second file" },
        ] },
      ],
    }, TRACE);
    const messages = messagesOf(await outbox.writeOutboxRequest(request));

    expect(contentOf(messages[0])[0]).toEqual({
      type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(contentOf(messages[2]).map((part) => part.tool_use_id)).toEqual(["toolu_read", "toolu_search"]);
    expect(contentOf(messages[4]).map((part) => part.tool_use_id))
      .toEqual(["toolu_read_second", "toolu_search_second"]);
  });
});

describe("抓包组合形态：Anthropic SSE 工具输入增量", () => {
  it("跨任意字节分片组装 tool_use JSON，并以 toolUse 收尾", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_stream","name":"Read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"fi"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"le.txt\\",\\"line\\":2}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const encoded = new TextEncoder().encode(sse);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const response = await assembleResponse(
      outbox.readOutboxResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } })),
      "fallback",
    );
    expect(response).toMatchObject({ model: "claude-test", stopReason: "toolUse", error: null, unhandled: [] });
    expect(response.turn.parts).toEqual([{
      kind: "toolCall",
      call: { id: "toolu_stream", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: { path: "file.txt", line: 2 } } },
    }]);
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

    const result = await outbox.writeOutboxRequest(request);
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
    const problems = rejected(await outbox.writeOutboxRequest(request));
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
    const problems = rejected(await outbox.writeOutboxRequest(request));
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
    const problems = rejected(await outbox.writeOutboxRequest(request));

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
    const result = await outbox.writeOutboxRequest(request);
    expect(result.ok).toBe(false);
    expect(result.losses.map((loss) => loss.kind)).toEqual(["dropped"]);
    expect(result.losses[0]?.stage).toBe("outbox");
    expect(result.losses[0]?.outbox).toBe("anthropic");
  });

  it("配齐结果之后同一形态的历史就能编译 —— 拒绝的是缺口，不是工具会话本身", async () => {
    const result = await outbox.writeOutboxRequest(fullRequest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.losses).toEqual([]);
  });
});

describe("全空会话", () => {
  it("编不出任何内容时拒绝，而不是静默产出 messages: [] 让上游 400", async () => {
    // 剥离 dropEmptyTurns 之后空回合会活到 outbox，这条路径因此变常见。
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: "" }, { role: "assistant", content: [] }],
    }, "tr-empty");
    const built = await createAnthropicOutbox({
      baseUrl: "https://example.invalid", apiKey: "k", model: "claude-opus-5",
    }).writeOutboxRequest(request);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problems).toContainEqual(expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.conversation.turns",
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 声明与投影必须一致：声明支持却不发，是不变量 3 的反面
// ═══════════════════════════════════════════════════════════════════════════

describe("会话身份：wire 有承载位就发", () => {
  /** 语料里 365/611 条 anthropic_messages 请求的原始形态。 */
  const CLIENT_METADATA = {
    user_id: JSON.stringify({
      device_id: "5378180456032bae90ae4ca4c77928756c9f3285caa54abbf81064f108a09818",
      account_uuid: "",
      session_id: "c508c824-8120-43b6-bec1-a569bf91d5d6",
    }),
  };

  it("metadata.user_id 原样往返 —— inbox 解出来的三段身份，outbox 逐字装回去", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16, metadata: CLIENT_METADATA,
      messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    // account_uuid 是空串，inbox 按「有但为空 = 没有」处理，所以 IR 里只剩两段。
    expect(request.intent.identity).toEqual({
      deviceId: "5378180456032bae90ae4ca4c77928756c9f3285caa54abbf81064f108a09818",
      sessionId: "c508c824-8120-43b6-bec1-a569bf91d5d6",
    });

    const body = bodyOf(await outbox.writeOutboxRequest(request));
    const metadata = body.metadata as { user_id: string };
    expect(JSON.parse(metadata.user_id)).toEqual({
      device_id: "5378180456032bae90ae4ca4c77928756c9f3285caa54abbf81064f108a09818",
      session_id: "c508c824-8120-43b6-bec1-a569bf91d5d6",
    });
    // 再解一次必须还是同一个 IR 身份：这条 wire 上身份是无损的。
    const roundTripped = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16, metadata: body.metadata as Record<string, unknown>,
      messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(roundTripped.request.intent.identity).toEqual(request.intent.identity);
  });

  it("客户端没给身份就整个字段不发，不补空壳", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(Object.hasOwn(bodyOf(await outbox.writeOutboxRequest(request)), "metadata")).toBe(false);
  });
});

describe("服务档位：wire 没有这个取值就不发，并留痕", () => {
  it("serviceTier 归 lossy 而不是 supports —— 声明支持却不发才是最糟的那一种", () => {
    expect(outbox.profile.supports.has("serviceTier")).toBe(false);
    expect(outbox.profile.lossy.has("serviceTier")).toBe(true);
  });

  it("客户端要 priority：body 里不写 service_tier，但必须有一条指到它的 loss", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16, service_tier: "priority",
      messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(request.intent.serviceTier).toEqual({ value: "priority", source: "client" });

    const built = await outbox.writeOutboxRequest(request);
    // wire 的 service_tier 只收 auto / standard_only；发一个 auto 只是把缺省又写一遍。
    expect(Object.hasOwn(bodyOf(built), "service_tier")).toBe(false);
    expect(built.losses).toContainEqual(expect.objectContaining({
      stage: "outbox", outbox: "anthropic", path: "$.intent.serviceTier", kind: "dropped",
    }));
  });

  it("客户端没提档位（gateway-default standard）：一条 loss 都不该有", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    const built = await outbox.writeOutboxRequest(request);
    expect(built.losses.filter((loss) => loss.path === "$.intent.serviceTier")).toEqual([]);
  });
});

describe("必填字段维度", () => {
  it("Anthropic 强制要求 max_tokens —— 声明与那条 requiredFieldMissing 拒绝是同一个事实", async () => {
    expect(outbox.profile.mandatory.maxOutputTokens).toBe(true);
    const { request } = readChatCompletionsRequest({
      model: "m", messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(request.intent.stopping.maxOutputTokens).toBeUndefined();
    expect(rejected(await outbox.writeOutboxRequest(request))).toContainEqual(expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.intent.stopping.maxOutputTokens",
    }));
  });

  it("对照：Chat Completions 不强制 max_tokens —— 强制性是 Anthropic wire 的事实，不是 Core 规则", async () => {
    // 同一条没有 max_tokens 的 IR：Anthropic 拒绝（上面那条），Chat 照编不误。
    // 缺了这条对照，`mandatory.maxOutputTokens` 就可能被误当成一条全局准入规则。
    const chat = createOpenAIChatOutbox({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });
    expect(chat.profile.mandatory.maxOutputTokens).toBe(false);
    const { request } = readChatCompletionsRequest({
      model: "m", messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    const built = await chat.writeOutboxRequest(request);
    expect(built.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * AGENTS.md 要求每个 Outbox 特化都带「不影响其他 Outbox」的反例。
 *
 * 这个出口最容易被误读成通用规则的特化只有一条：**空工具结果补 `""`**。
 * 它在本文件里被论证为编译事实（Anthropic 编码不出空内容数组），但「编译事实」的
 * 判据是 *这条 wire* 的，不是 IR 的 —— 另外两个出口在同一条 IR 上必须**拒绝**。
 * 一旦哪天有人把这个补值上提到共享投影或 Core，这条会当场红。
 */
describe("特化不外溢：空工具结果补最小合法值只属于 Anthropic wire", () => {
  function emptyToolResult(): IRRequest {
    return readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [] }] },
      ],
    }, TRACE).request;
  }

  it("Anthropic 补 \"\" 并编译成功", async () => {
    const result = await outbox.writeOutboxRequest(emptyToolResult());
    expect(contentOf(messagesOf(result)[1])[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_1", content: "" });
  });

  it("同一条 IR 走 openai_chat / openai_responses：拒绝，且路径指到那个 toolResult part", async () => {
    const chat = createOpenAIChatOutbox({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });
    const responses = createOpenAIResponsesOutbox({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });

    for (const other of [chat, responses]) {
      const problems = rejected(await other.writeOutboxRequest(emptyToolResult()));
      expect(problems).toContainEqual(expect.objectContaining({
        kind: "requiredFieldMissing",
        path: "$.conversation.turns[1].parts[0]",
      }));
    }
  });
});
