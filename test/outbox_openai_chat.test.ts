/**
 * OpenAI Chat Completions 出口。
 *
 * readOutboxResponse 用的 SSE 报文是**真实形状**，逐帧照抄自生产网关流量日志
 * 里 108115 条 `chat.completion.chunk`（deepseek-v4-flash / kimi-k3 等兼容端点，
 * 2026-07-31..08-04），包括三个容易被臆想掉的细节：
 *   - `delta.content` 常态是 **null**（107486 条带这个键，大量为 null），不是省略；
 *   - 工具调用续帧带 `id:""` 与 `function.name:""`，不是省略这两个键；
 *   - 收尾的 usage 单独成帧，`choices: []`，之后才是 `data: [DONE]`。
 *
 * lower 的 IR 一律由入口 decode 真实请求体得到，不手搓 IR —— 手搓的 IR 只能验证
 * 我对自己的假设。
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicOutbox } from "../src/outbox/anthropic.ts";
import { createOpenAIChatOutbox } from "../src/outbox/openai_chat_completions.ts";
import { createOpenAIResponsesOutbox } from "../src/outbox/openai_responses.ts";
import { readAnthropicMessagesRequest } from "../src/inbox/index.ts";
import { checkOutboxSupport } from "../src/ir/admission.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import {
  clientValue, defaultValue,
  type IRBuildProblem, type IRConversation, type IREvent, type IRIntent, type IRLoss, type IRRequest,
  type IRToolChoice, type IROutputFormat, type IRReasoning, type IRWireRequest,
} from "../src/ir/types.ts";

const TRACE = "tr-test";

const outbox = createOpenAIChatOutbox({
  baseUrl: "https://api.openai.com/v1/",
  apiKey: "sk-test",
  model: "gpt-5-mini",
});

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
    reasoning: defaultValue<IRReasoning>({ mode: "auto", display: "summarized" }),
    outputFormat: defaultValue<IROutputFormat>({ kind: "text" }),
    serviceTier: defaultValue("standard" as const),
    sampling: {}, stopping: {}, contextEdits: [],
    stream: defaultValue(false), identity: {},
    ...over.intent,
  };
  const partial = {
    traceId: TRACE, protocol: "openai_chat_completions" as const, model: "m", conversation, intent,
  };
  return { ...partial, requires: deriveCapabilityNeeds(partial) };
}

function body(wire: { body: string }): Record<string, unknown> {
  return JSON.parse(wire.body) as Record<string, unknown>;
}

function messagesOf(wire: { body: string }): Array<Record<string, unknown>> {
  return body(wire).messages as Array<Record<string, unknown>>;
}

function findLoss(losses: readonly IRLoss[], fragment: string): IRLoss | undefined {
  return losses.find((loss) => loss.detail.includes(fragment));
}

/**
 * `writeOutboxRequest` 是**编译或拒绝**的判别联合。成功用例统一从这里剥出 wire ——
 * 万一被拒，失败信息里直接是 problems，而不是一句「wire is undefined」。
 */
async function compiled(request: IRRequest): Promise<{
  readonly wire: IRWireRequest;
  readonly losses: readonly IRLoss[];
}> {
  const built = await outbox.writeOutboxRequest(request);
  if (!built.ok) throw new Error(`expected a compiled request, got problems: ${JSON.stringify(built.problems)}`);
  return { wire: built.wire, losses: built.losses };
}

/** 期望拒绝。返回 problems 与拒绝前已记下的 losses（契约要求两者一并交出）。 */
async function rejected(request: IRRequest): Promise<{
  readonly problems: readonly IRBuildProblem[];
  readonly losses: readonly IRLoss[];
}> {
  const built = await outbox.writeOutboxRequest(request);
  if (built.ok) throw new Error(`expected a rejection, got a wire: ${built.wire.body}`);
  return { problems: built.problems, losses: built.losses };
}

function sse(chunks: readonly unknown[], { done = true }: { done?: boolean } = {}): Response {
  const text = chunks.map((chunk) =>
    `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("能力声明", () => {
  it("supports 与 lossy 不相交；两个集合都不放的三项是真的表达不了的", () => {
    const { supports, lossy } = outbox.profile;
    for (const capability of supports) expect(lossy.has(capability)).toBe(false);
    // 文档、内建工具、工具结果里的图片：降级之后模型看到的东西就少了，只能让准入层拒。
    for (const capability of ["document", "toolBuiltin", "toolResultImage"] as const) {
      expect(supports.has(capability)).toBe(false);
      expect(lossy.has(capability)).toBe(false);
    }
    // 思考签名与缓存断点是供应商私有元数据，丢了不改变模型看到的内容 → 有损放行。
    for (const capability of ["thinking", "thinkingSignature", "cacheBreakpoint", "contextEdit"] as const) {
      expect(lossy.has(capability)).toBe(true);
    }
  });

  it("工具结果里的图片被准入层拒掉，并指到具体 IR 路径", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Screenshot", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result", tool_use_id: "toolu_1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
          }],
        },
      ],
    }, TRACE);
    const verdict = checkOutboxSupport(request, outbox.profile);
    expect(verdict.admitted).toBe(false);
    expect(verdict.unsupported.map((need) => need.capability)).toContain("toolResultImage");
    const need = verdict.unsupported.find((entry) => entry.capability === "toolResultImage");
    expect(need?.paths[0]).toContain("result.parts[0]");
  });

  it("带签名 thinking 的请求（语料 611 条 anthropic 里 464 条）能过准入，只记有损", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 16,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "text", text: "ok" }] },
      ],
    }, TRACE);
    const verdict = checkOutboxSupport(request, outbox.profile);
    expect(verdict.admitted).toBe(true);
    expect(verdict.losses.map((loss) => loss.path).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lower：wire 形状", () => {
  it("system + 多轮 + 并行工具调用 + 工具结果", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "claude-opus-5", max_tokens: 1024, stream: true,
      system: [{ type: "text", text: "you are a gateway" }],
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      tool_choice: { type: "auto" },
      temperature: 0.7,
      messages: [
        { role: "user", content: "list two dirs" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls /a" } },
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls /b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: [{ type: "text", text: "a.txt" }] },
            { type: "tool_result", tool_use_id: "toolu_b", content: [{ type: "text", text: "b.txt" }] },
            { type: "text", text: "now summarise" },
          ],
        },
      ],
    }, TRACE);

    const { wire, losses } = await compiled(request);
    expect(wire.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(wire.headers.authorization).toBe("Bearer sk-test");
    expect(wire.headers["content-type"]).toBe("application/json");

    const payload = body(wire);
    expect(payload.model).toBe("gpt-5-mini");
    expect(payload.stream).toBe(true);
    // include_usage 不带的话整条流一个 token 数都拿不到。
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.max_tokens).toBe(1024);
    expect(payload.temperature).toBe(0.7);
    expect(payload.tools).toEqual([{
      type: "function",
      function: { name: "Bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } },
    }]);
    expect(payload.tool_choice).toBe("auto");

    const messages = messagesOf(wire);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(messages[0]).toEqual({ role: "system", content: "you are a gateway" });
    expect(messages[1]).toEqual({ role: "user", content: "list two dirs" });

    const assistant = messages[2] as { content: unknown; tool_calls: Array<Record<string, unknown>> };
    expect(assistant.content).toBe("sure");
    expect(assistant.tool_calls).toHaveLength(2);
    // arguments 是 JSON **字符串**，不是对象。
    expect(assistant.tool_calls[0]).toEqual({
      id: "toolu_a", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls /a\"}" },
    });
    expect(typeof (assistant.tool_calls[1]?.function as Record<string, unknown>).arguments).toBe("string");

    // tool 消息必须紧跟声明该 id 的 assistant 消息，且按调用顺序。
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_a", content: "a.txt" });
    expect(messages[4]).toEqual({ role: "tool", tool_call_id: "toolu_b", content: "b.txt" });
    expect(messages[5]).toEqual({ role: "user", content: "now summarise" });

    expect(losses).toEqual([]);
  });

  it("正常请求 ok:true，wire 逐字段锁死", async () => {
    const request = irRequest({
      conversation: { turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }] },
      intent: { stream: clientValue(true), stopping: { maxOutputTokens: clientValue(64) } },
    });
    const { wire, losses } = await compiled(request);
    expect(wire.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(wire.method).toBe("POST");
    expect(wire.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
    });
    expect(JSON.parse(wire.body)).toEqual({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    });
    expect(losses).toEqual([]);
  });

  it("确定性：同一个 IR 连续构造两次，body 字节完全相同", async () => {
    const request = irRequest({
      conversation: {
        turns: [
          { role: "user", parts: [{ kind: "text", text: "hi" }] },
          { role: "assistant", parts: [
            { kind: "toolCall", call: { id: "call_1", toolRef: { group: "mcp", name: "read" }, input: { kind: "json", value: { path: "/tmp" } } } },
          ] },
          { role: "user", parts: [
            { kind: "toolResult", result: { callId: "call_1", parts: [{ kind: "text", text: "ok" }], status: "ok" } },
          ] },
        ],
        toolset: {
          tools: [{ kind: "function", ref: { group: "mcp", name: "read" }, description: "r", schema: { type: "object" } }],
          groups: [{ name: "mcp", members: ["read"] }],
          choice: clientValue<IRToolChoice>({ kind: "auto" }),
          parallel: clientValue(true),
        },
      },
    });
    const first = await compiled(request);
    const second = await compiled(request);
    expect(second.wire.body).toBe(first.wire.body);
    expect(second.wire).toEqual(first.wire);
    expect(second.losses).toEqual(first.losses);
  });

  it("user 消息里的图片走 image_url，base64 转成 data: URI", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      }],
    }, TRACE);
    const { wire, losses } = await compiled(request);
    expect(messagesOf(wire)[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    });
    expect(losses).toEqual([]);
  });

  // 旧行为：悬空调用补一条占位 tool 消息、孤儿结果直接丢，各记一条 loss。
  // 两者都是「网关替客户端决定」，已剥离到 src/repair —— Core 现在只拒绝。
  it("悬空调用与孤儿结果一次全收集地拒绝，不发一个上游必然 400 的 body", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_live", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ghost", content: "orphan" }] },
      ],
    }, TRACE);
    const { problems } = await rejected(request);

    const dangling = problems.find((problem) => problem.kind === "danglingToolCall");
    expect(dangling?.path).toBe("$.conversation.turns[0].parts[0]");
    expect(dangling?.detail).toContain("toolu_live");
    expect(dangling?.detail).toContain("fillDanglingToolCall");

    const orphan = problems.find((problem) => problem.kind === "orphanToolResult");
    expect(orphan?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(orphan?.detail).toContain("toolu_ghost");
    expect(orphan?.detail).toContain("dropOrphanToolResult");

    // 遇到第一个问题就短路的话，客户端要修两轮才能把同一条请求修好。
    expect(problems).toHaveLength(2);
  });

  it("三类问题混在一条请求里：全部收齐，且拒绝前的 losses 一并交出", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, top_k: 40,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_dangling", name: "Bash", input: {} },
            { type: "tool_use", id: "toolu_empty", name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_empty", content: [] },
            { type: "tool_result", tool_use_id: "toolu_ghost", content: "orphan" },
          ],
        },
      ],
    }, TRACE);
    const { problems, losses } = await rejected(request);

    expect(problems.map((problem) => problem.kind).sort()).toEqual(
      ["danglingToolCall", "orphanToolResult", "requiredFieldMissing"]);
    expect(problems.map((problem) => problem.path).sort()).toEqual([
      "$.conversation.turns[0].parts[0]",
      "$.conversation.turns[1].parts[0]",
      "$.conversation.turns[1].parts[1]",
    ]);
    // 有损条目照样交出：调用方一次就能看全「拒绝理由 + 已经知道会丢什么」。
    expect(findLoss(losses, "no top_k")?.path).toBe("$.intent.sampling.topK");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lower：每一处降级都留痕", () => {
  it("thinking 与 signature 整块丢弃并各记一条", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "deep", signature: "sig-abc" },
            { type: "redacted_thinking", data: "zzz" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    }, TRACE);
    const { wire, losses } = await compiled(request);
    const assistant = messagesOf(wire)[1];
    expect(assistant?.content).toBe("answer");

    const thinkingLoss = findLoss(losses, "its signature has no field at all");
    expect(thinkingLoss?.kind).toBe("dropped");
    expect(thinkingLoss?.stage).toBe("outbox");
    expect(thinkingLoss?.outbox).toBe("openai_chat");
    expect(thinkingLoss?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(findLoss(losses, "redacted thinking")?.kind).toBe("dropped");
  });

  it("cache_control / context_management / top_k / metadata 各记一条 dropped", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, top_k: 40,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      metadata: { user_id: JSON.stringify({ session_id: "s-1", account_uuid: "acc-1" }) },
      messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    const { losses } = await compiled(request);

    const cache = findLoss(losses, "no cache_control");
    expect(cache?.kind).toBe("dropped");
    expect(cache?.path).toBe("$.conversation.system[0].cacheBreakpoint");

    const contextEdit = findLoss(losses, "no context_management");
    expect(contextEdit?.kind).toBe("dropped");
    expect(contextEdit?.path).toBe("$.intent.contextEdits[0]");

    expect(findLoss(losses, "no top_k")?.path).toBe("$.intent.sampling.topK");
    expect(findLoss(losses, "no session identity")?.path).toBe("$.intent.identity");
  });

  it("freeform 工具省掉 parameters、builtin 工具丢弃、分组拍进名字", async () => {
    const request = irRequest({
      conversation: {
        toolset: {
          tools: [
            { kind: "freeform", ref: { group: null, name: "apply_patch" }, description: "patch" },
            { kind: "builtin", ref: { group: null, name: "web_search" }, builtin: "web_search_20250305" },
            { kind: "function", ref: { group: "mcp", name: "read" }, description: "r", schema: { type: "object" } },
          ],
          groups: [{ name: "mcp", members: ["read"] }],
          choice: clientValue<IRToolChoice>({ kind: "specific", ref: { group: "mcp", name: "read" } }),
          parallel: clientValue(false),
        },
        turns: [{ role: "user", parts: [{ kind: "text", text: "go" }] }],
      },
    });
    const { wire, losses } = await compiled(request);
    const payload = body(wire);
    expect(payload.tools).toEqual([
      { type: "function", function: { name: "apply_patch", description: "patch" } },
      { type: "function", function: { name: "mcp__read", description: "r", parameters: { type: "object" } } },
    ]);
    expect(payload.tool_choice).toEqual({ type: "function", function: { name: "mcp__read" } });
    expect(payload.parallel_tool_calls).toBe(false);

    expect(findLoss(losses, "no freeform argument form")?.kind).toBe("degraded");
    expect(findLoss(losses, "builtin tool 'web_search_20250305'")?.kind).toBe("dropped");
    expect(findLoss(losses, "flattened into the tool name")?.kind).toBe("degraded");
  });

  it("工具结果的 is_error 折进正文 —— 编译事实：写进去的是 IR 里已有的 status", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_e", content: "boom", is_error: true }] },
      ],
    }, TRACE);
    const { wire, losses } = await compiled(request);
    expect(messagesOf(wire)[1]).toEqual({ role: "tool", tool_call_id: "toolu_e", content: "[tool error] boom" });
    expect(findLoss(losses, "no is_error flag")?.kind).toBe("degraded");
  });

  // 旧行为：空结果补 `(empty)`。那是替客户端宣布「工具跑成功且无输出」，agent 会照着往下走。
  it("空工具结果拒绝，不再补 `(empty)`", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_empty", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_empty", content: [] }] },
      ],
    }, TRACE);
    const { problems } = await rejected(request);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(problems[0]?.detail).toContain("toolu_empty");
    expect(problems[0]?.detail).toContain("fillEmptyToolResult");
  });

  it("thinking budget 折成 reasoning_effort 档位，effort 越界夹到 high", async () => {
    const budget = await compiled(irRequest({
      intent: { reasoning: clientValue<IRReasoning>({ mode: "enabled", budgetTokens: 8000, display: "summarized" }) },
    }));
    expect(body(budget.wire).reasoning_effort).toBe("high");
    expect(findLoss(budget.losses, "bucketed into reasoning_effort")?.kind).toBe("degraded");

    // 夹档是编译事实（同一根强度轴降分辨率），但**必须留痕，且 detail 要含原值与夹后值**：
    // 只写结果的留痕，事后无法从日志还原客户端当初要的是哪一档。
    // 越界的两档都跑一遍：判断与夹后值都由 `EFFORT_WIRE` 派生，任何一档漏表态都会在这里现形。
    for (const effort of ["xhigh", "max"] as const) {
      const clamped = await compiled(irRequest({
        intent: { reasoning: clientValue<IRReasoning>({ mode: "enabled", effort, display: "summarized" }) },
      }));
      expect(body(clamped.wire).reasoning_effort).toBe("high");
      const clampLoss = findLoss(clamped.losses, "clamped to");
      expect(clampLoss?.kind).toBe("substituted");
      expect(clampLoss?.path).toBe("$.intent.reasoning.effort");
      expect(clampLoss?.detail).toContain(`'${effort}'`);  // 原值
      expect(clampLoss?.detail).toContain("'high'");       // 夹后值
    }

    // 反面：wire 原样承得住的档位**不记** loss —— 有损留痕不等于逢 effort 就留痕。
    const exact = await compiled(irRequest({
      intent: { reasoning: clientValue<IRReasoning>({ mode: "enabled", effort: "medium", display: "summarized" }) },
    }));
    expect(body(exact.wire).reasoning_effort).toBe("medium");
    expect(findLoss(exact.losses, "clamped to")).toBeUndefined();
  });

  it("stop 超过 4 条截断（编译事实：wire 的容量就是 4）", async () => {
    const { wire, losses } = await compiled(irRequest({
      intent: {
        stopping: {
          maxOutputTokens: clientValue(256),
          stopSequences: clientValue(["a", "b", "c", "d", "e"]),
        },
      },
    }));
    expect(body(wire).stop).toEqual(["a", "b", "c", "d"]);
    expect(findLoss(losses, "at most 4 stop sequences")?.kind).toBe("truncated");
  });

  /**
   * AGENTS.md 要求的「不影响其他 Outbox」的反例。
   *
   * 上面那条截断的判据是 **Chat Completions 的 `stop` 只装得下 4 条**，不是「IR 认为
   * 超过 4 条就该砍」。判据既然是 wire 的，同一条 IR 换个出口就必须是另一种结局 ——
   * Anthropic 有 `stop_sequences` 且不限 4 条，`/v1/responses` 根本没有这个参数。
   * 三条路由三种结局，正好把「这是 wire 容量，不是 Core 规则」钉死。
   */
  it("特化不外溢：同一条 5 项 stop 换出口是三种结局，截断只属于 Chat 的 wire", async () => {
    const fiveStops = irRequest({
      // Anthropic 编不出空 messages，所以这条对照必须带一句真实正文 ——
      // 要比的是 stop 的三种结局，不是「空会话谁先拒」。
      conversation: { turns: [{ role: "user", parts: [{ kind: "text", text: "go" }] }] },
      intent: {
        stopping: {
          maxOutputTokens: clientValue(256),
          stopSequences: clientValue(["a", "b", "c", "d", "e"]),
        },
      },
    });

    const anthropic = createAnthropicOutbox({ baseUrl: "https://api.anthropic.com/", apiKey: "k", model: "m" });
    const anthropicBuilt = await anthropic.writeOutboxRequest(fiveStops);
    if (!anthropicBuilt.ok) throw new Error(`expected a compiled request: ${JSON.stringify(anthropicBuilt.problems)}`);
    // 全 5 条原样送达，一条 loss 都不该有。
    expect((JSON.parse(anthropicBuilt.wire.body) as Record<string, unknown>).stop_sequences)
      .toEqual(["a", "b", "c", "d", "e"]);
    expect(anthropicBuilt.losses.filter((loss) => loss.path === "$.intent.stopping.stopSequences")).toEqual([]);

    const responses = createOpenAIResponsesOutbox({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" });
    const responsesBuilt = await responses.writeOutboxRequest(fiveStops);
    if (!responsesBuilt.ok) throw new Error(`expected a compiled request: ${JSON.stringify(responsesBuilt.problems)}`);
    const responsesBody = JSON.parse(responsesBuilt.wire.body) as Record<string, unknown>;
    // Responses 没有 stop 参数：整条丢掉并记 dropped，而不是悄悄截成 4 条。
    expect(Object.hasOwn(responsesBody, "stop")).toBe(false);
    expect(Object.hasOwn(responsesBody, "stop_sequences")).toBe(false);
    expect(responsesBuilt.losses).toContainEqual(expect.objectContaining({
      path: "$.intent.stopping.stopSequences", kind: "dropped",
    }));
  });

  it("客户端给了 json_schema.name 就照发", async () => {
    const { wire, losses } = await compiled(irRequest({
      intent: {
        outputFormat: clientValue<IROutputFormat>({
          kind: "jsonSchema", name: "verdict", schema: { type: "object" }, strict: true,
        }),
      },
    }));
    expect(body(wire).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
    });
    expect(losses).toEqual([]);
  });

  // 旧行为：缺 name 时补 'response'。那个名字会随结构化输出回到客户端手里，网关无权替它取。
  it("json_schema 缺 name 时拒绝，不再补 'response'", async () => {
    const { problems } = await rejected(irRequest({
      intent: {
        outputFormat: clientValue<IROutputFormat>({ kind: "jsonSchema", schema: { type: "object" }, strict: true }),
      },
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.intent.outputFormat");
    expect(problems[0]?.detail).toContain("json_schema.name");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readOutboxResponse：正常流", () => {
  // 帧形状照抄 deepseek-v4-flash 的真实流量。
  const first = {
    id: "chatcmpl-real", object: "chat.completion.chunk", created: 1785600127,
    model: "deepseek-v4-flash", system_fingerprint: null, usage: null,
    choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: null }, logprobs: null, finish_reason: null }],
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    ...first, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  });

  it("文本 + 推理 + 工具调用分片累加 + finish_reason + usage", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      first,
      chunk({ content: null, reasoning_content: "let me" }),
      chunk({ content: null, reasoning_content: " think" }),
      chunk({ content: "running", reasoning_content: null }),
      chunk({
        content: null, reasoning_content: null,
        tool_calls: [{ index: 0, id: "call_e26352a0", type: "function", function: { name: "read", arguments: "" } }],
      }),
      // 续帧：id 与 name 是空串而不是缺省，不能拿它们覆盖首帧。
      chunk({ content: null, tool_calls: [{ index: 0, id: "", type: "function", function: { name: "", arguments: "{\"path\":" } }] }),
      chunk({ content: null, tool_calls: [{ index: 0, id: "", type: "function", function: { name: "", arguments: "\"/tmp\"}" } }] }),
      chunk({
        content: null,
        tool_calls: [{ index: 1, id: "call_second", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      chunk({ content: "" }, "tool_calls"),
      {
        id: "chatcmpl-real", object: "chat.completion.chunk", created: 1785600127, model: "deepseek-v4-flash",
        choices: [],
        usage: { prompt_tokens: 1200, completion_tokens: 42, total_tokens: 1242, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 17 } },
      },
    ])));

    expect(events[0]).toEqual({ kind: "messageStart", model: "deepseek-v4-flash" });
    expect(events.some((event) => event.kind === "unhandled")).toBe(false);

    const starts = events.filter((event) => event.kind === "partStart");
    expect(starts.map((event) => (event as Extract<IREvent, { kind: "partStart" }>).part.kind))
      .toEqual(["thinking", "text", "toolCall", "toolCall"]);

    const thinking = events.filter((event) => event.kind === "partDelta" && event.delta.kind === "thinking");
    expect(thinking.map((event) => (event as Extract<IREvent, { kind: "partDelta" }>).delta))
      .toEqual([{ kind: "thinking", text: "let me" }, { kind: "thinking", text: " think" }]);

    // 工具入参按分片累加，索引落在同一个 IR part 上。
    const toolPart = starts[2] as Extract<IREvent, { kind: "partStart" }>;
    const call = toolPart.part.kind === "toolCall" ? toolPart.part.call : null;
    expect(call?.id).toBe("call_e26352a0");
    expect(call?.toolRef).toEqual({ group: null, name: "read" });
    const fragments = events.filter(
      (event): event is Extract<IREvent, { kind: "partDelta" }> =>
        event.kind === "partDelta" && event.delta.kind === "toolInputJson" && event.index === toolPart.index);
    expect(fragments.map((event) => (event.delta as { json: string }).json).join("")).toBe("{\"path\":\"/tmp\"}");

    // 终止前所有开着的 part 都收口。
    const ends = events.filter((event) => event.kind === "partEnd").map((event) => (event as { index: number }).index);
    expect(ends).toEqual([0, 1, 2, 3]);

    const stop = events.find((event) => event.kind === "messageStop");
    expect(stop).toEqual({ kind: "messageStop", reason: "toolUse" });

    // prompt_tokens 含缓存命中，IR 用 Anthropic 语义（不含）—— 必须减出来。
    const usage = events.find((event) => event.kind === "usage");
    expect(usage).toEqual({
      kind: "usage",
      usage: { inputTokens: 200, outputTokens: 42, cacheReadTokens: 1000, reasoningTokens: 17 },
    });
  });

  it("finish_reason=length → maxTokens；[DONE] 本身不是终止信号", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      chunk({ content: "half" }),
      chunk({}, "length"),
    ])));
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
    expect(events.some((event) => event.kind === "unhandled")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readOutboxResponse：没匹配上的一律进 unhandled", () => {
  it("未知 delta 字段 / 未知 finish_reason / 认不出形状的 chunk / 非 JSON 帧", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      { object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "hi", audio: { id: "a" } }, finish_reason: null }] },
      { object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "recitation" }] },
      { object: "chat.completion.pigeon", model: "m", pigeon: true },
      "not json at all",
    ])));

    const unhandled = events.filter(
      (event): event is Extract<IREvent, { kind: "unhandled" }> => event.kind === "unhandled");
    expect(unhandled.map((event) => event.rawType)).toEqual([
      "delta:audio", "finish_reason:recitation", "chat.completion.pigeon", "<unparseable>",
    ]);
    expect(unhandled[0]?.raw).toEqual({ audio: { id: "a" } });
    // 未知 finish_reason 仍然要终止，只是同时把漂移暴露出来。
    expect(events.some((event) => event.kind === "messageStop")).toBe(true);
  });

  it("n>1 的多候选不静默丢", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      { object: "chat.completion.chunk", model: "m", choices: [
        { index: 0, delta: { content: "a" }, finish_reason: null },
        { index: 1, delta: { content: "b" }, finish_reason: null },
      ] },
      { object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ])));
    const unhandled = events.filter(
      (event): event is Extract<IREvent, { kind: "unhandled" }> => event.kind === "unhandled");
    expect(unhandled.map((event) => event.rawType)).toEqual(["choice:index=1"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readOutboxResponse：流被截断绝不伪装成成功", () => {
  it("没有 finish_reason 就结束 → error，而不是「200 但空」", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      { object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "half a sen" }, finish_reason: null }] },
    ])));
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);
    const error = events.at(-1);
    expect(error).toEqual({
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a finish_reason", raw: null,
      },
    });
    // 开着的 part 也要收口，下游不会留一个永远不关的块。
    expect(events.some((event) => event.kind === "partEnd")).toBe(true);
  });

  it("[DONE] 单独收尾同样算截断", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([], { done: true })));
    expect(events.filter((event) => event.kind === "error")).toHaveLength(1);
  });

  it("流里插一条 error 帧 → 终止且不再补 transport 错误", async () => {
    const events = await collect(outbox.readOutboxResponse(sse([
      { object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
      { error: { message: "This model's maximum context length is 128000 tokens", type: "invalid_request_error", code: "context_length_exceeded" } },
    ])));
    const errors = events.filter(
      (event): event is Extract<IREvent, { kind: "error" }> => event.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.kind).toBe("contextLengthExceeded");
    expect(errors[0]?.error.retryable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readOutboxResponse：非流式合成等价事件序列", () => {
  it("chat.completion JSON → messageStart / partStart+partEnd / usage / messageStop", async () => {
    const response = Response.json({
      id: "chatcmpl-x", object: "chat.completion", created: 1785600127, model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: "done", reasoning_content: "thought",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"/tmp\"}" } },
            { id: "call_2", type: "function", function: { name: "patch", arguments: "*** Begin Patch" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    const events = await collect(outbox.readOutboxResponse(response));
    expect(events[0]).toEqual({ kind: "messageStart", model: "deepseek-v4-flash" });
    const starts = events.filter(
      (event): event is Extract<IREvent, { kind: "partStart" }> => event.kind === "partStart");
    expect(starts.map((event) => event.part.kind)).toEqual(["thinking", "text", "toolCall", "toolCall"]);
    // 每个 part 都成对收口，下游不必区分流式与非流式。
    expect(events.filter((event) => event.kind === "partEnd")).toHaveLength(4);

    const patch = starts[3]?.part;
    // arguments 解析不出对象时保留原文当 freeform 入参，不吃掉内容。
    expect(patch?.kind === "toolCall" ? patch.call.input : null).toEqual({ kind: "text", text: "*** Begin Patch" });

    expect(events.find((event) => event.kind === "usage"))
      .toEqual({ kind: "usage", usage: { inputTokens: 10, outputTokens: 4 } });
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "toolUse" });
  });

  it("200 但没有 choices → error，不是空成功", async () => {
    const events = await collect(outbox.readOutboxResponse(Response.json({ id: "x", object: "chat.completion", choices: [] })));
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);
    const error = events.find(
      (event): event is Extract<IREvent, { kind: "error" }> => event.kind === "error");
    expect(error?.error.message).toContain("no choices");
  });

  it("200 但 body 不是 JSON（网关错误页）→ transport error", async () => {
    const events = await collect(outbox.readOutboxResponse(new Response("<html>502</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", error: { kind: "transport", retryable: true } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readOutboxResponse：上游 4xx/5xx", () => {
  const cases: ReadonlyArray<{
    readonly status: number;
    readonly payload: unknown;
    readonly kind: string;
    readonly retryable: boolean;
  }> = [
    {
      status: 400,
      payload: { error: { message: "This model's maximum context length is 128000 tokens, however you requested 190000", type: "invalid_request_error", code: "context_length_exceeded" } },
      kind: "contextLengthExceeded", retryable: false,
    },
    {
      status: 400,
      payload: { error: { message: "Invalid value for 'tool_choice'", type: "invalid_request_error", code: null } },
      kind: "invalidRequest", retryable: false,
    },
    {
      status: 401,
      payload: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } },
      kind: "permissionDenied", retryable: false,
    },
    {
      status: 429,
      payload: { error: { message: "Rate limit reached for gpt-5-mini", type: "rate_limit_error", code: "rate_limit_exceeded" } },
      kind: "rateLimited", retryable: true,
    },
    {
      status: 429,
      payload: { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } },
      kind: "quotaExhausted", retryable: false,
    },
    {
      status: 503,
      payload: { error: { message: "The server is overloaded", type: "server_error", code: null } },
      kind: "outboxUnavailable", retryable: true,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.status} → ${testCase.kind}（retryable=${testCase.retryable}）`, async () => {
      const events = await collect(outbox.readOutboxResponse(Response.json(testCase.payload, { status: testCase.status })));
      expect(events).toHaveLength(1);
      const event = events[0] as Extract<IREvent, { kind: "error" }>;
      expect(event.kind).toBe("error");
      expect(event.error.kind).toBe(testCase.kind as never);
      expect(event.error.retryable).toBe(testCase.retryable);
      expect(event.error.httpStatus).toBe(testCase.status);
      expect(event.error.raw).toEqual(testCase.payload);
    });
  }

  it("错误 body 不是 JSON（nginx 502 页）也要有正确的 kind", async () => {
    const events = await collect(outbox.readOutboxResponse(new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 })));
    const event = events[0] as Extract<IREvent, { kind: "error" }>;
    expect(event.error.kind).toBe("outboxUnavailable");
    expect(event.error.retryable).toBe(true);
  });
});
