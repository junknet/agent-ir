/**
 * GitHub Copilot 出口。
 *
 * 这个文件盯的是两条线：
 *
 *   1. **投影只有一份。** Copilot 与原生 Anthropic 编出的 body 必须**逐字节相同**（除 model），
 *      因为它们跑的是同一份投影。这条断言就是「不许出现第二份 Anthropic wire 认知」的守卫：
 *      谁把投影复制一份改一改，这里当场红。
 *   2. **差别只在方言。** 端点与身份头、能力声明、以及两条有实证的复核
 *      （context_management 必删、computer_* 必拒）。
 *
 * IR 一律由入口 decode 真实请求体得到，不手搓 —— 手搓的 IR 只能验证我对自己的假设。
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicUpstream } from "../src/egress/anthropic.ts";
import { createCopilotUpstream } from "../src/egress/copilot.ts";
import { readAnthropicMessagesRequest, readChatCompletionsRequest } from "../src/ingress/index.ts";
import type {
  IRBuildProblem, IRCapability, IREvent, IRRequest, IRUpstreamError, UpstreamRequestBuildResult,
} from "../src/ir/types.ts";

const TRACE = "tr-copilot";

/** 生产形态：base URL 是每个凭据自己的（`/copilot_internal/user` 的 endpoints.api）。 */
const API_BASE = "https://api.enterprise.githubcopilot.com";

const egress = createCopilotUpstream({
  model: "claude-opus-5-copilot",
  apiBase: `${API_BASE}/`,
  sessionToken: "tid=deadbeef;exp=1;sku=max",
  githubToken: "gho_test",
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

/** 一条真实 Claude Code 形态的请求：system + 多轮 + 并行工具 + 思考签名 + 缓存断点。 */
function fullRequest(): IRRequest {
  return readAnthropicMessagesRequest({
    model: "claude-opus-5",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "you are a gateway", cache_control: { type: "ephemeral" } }],
    temperature: 0.3,
    stop_sequences: ["</done>"],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    tool_choice: { type: "tool", name: "Read" },
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
          { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "and also this" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "b-content" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "a-content", is_error: true },
        ],
      },
    ],
  }, TRACE).request;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("wire：端点与身份头", () => {
  it("url 与全部身份头逐字段固定 —— 缺 integration-id 鉴权失败、缺 api-version 会 404", async () => {
    const wire = ok(await egress.writeUpstreamRequest(fullRequest()));

    // base URL 末尾的斜杠由出口规整，不靠调用方约定。
    expect(wire.url).toBe("https://api.enterprise.githubcopilot.com/v1/messages");
    expect(wire.headers).toEqual({
      "content-type": "application/json",
      // 两段式鉴权的两头，生产两个都发。
      authorization: "Bearer gho_test",
      "copilot-session-token": "tid=deadbeef;exp=1;sku=max",
      "copilot-integration-id": "copilot-developer-cli",
      "editor-version": "copilot/1.0.73",
      "x-github-api-version": "2026-07-01",
      "user-agent": "copilot/1.0.73 (linux v24.16.0) term/unknown",
      "anthropic-version": "2023-06-01",
      "x-initiator": "user",
      "x-interaction-type": "conversation-user",
      accept: "text/event-stream",
    });
    // 客户端的 key 绝不出现在出站头里。
    expect(wire.headers["x-api-key"]).toBeUndefined();
  });

  it("身份头不可能缺：它是构造出来的，客户端头压不过它，anthropic-beta 会被剥掉", async () => {
    const withForwarded = createCopilotUpstream({
      model: "m", apiBase: API_BASE, sessionToken: "s", githubToken: "g",
      extraHeaders: {
        // 三类都试：想顶掉身份头的、想塞回鉴权的、上游必拒的 beta。
        "copilot-integration-id": "attacker",
        "user-agent": "curl/8",
        authorization: "Bearer client-key",
        "x-api-key": "sk-ant-client",
        "copilot-session-token": "client-session",
        "anthropic-beta": "advisor-tool-2026-03-01",
        "x-trace": "keep-me",
      },
    });
    const wire = ok(await withForwarded.writeUpstreamRequest(fullRequest()));

    expect(wire.headers["copilot-integration-id"]).toBe("copilot-developer-cli");
    expect(wire.headers["user-agent"]).toBe("copilot/1.0.73 (linux v24.16.0) term/unknown");
    expect(wire.headers.authorization).toBe("Bearer g");
    expect(wire.headers["copilot-session-token"]).toBe("s");
    expect(wire.headers["x-api-key"]).toBeUndefined();
    // 上游 Bedrock 对新 beta 回 400 —— 剥离是按真实流量整形，不是偏好。
    expect(wire.headers["anthropic-beta"]).toBeUndefined();
    // 与身份无关的头照常透传。
    expect(wire.headers["x-trace"]).toBe("keep-me");
  });

  it("凭据每条请求现取 —— session token 会过期，回调返回什么就发什么", async () => {
    const issued: string[] = [];
    const rotating = createCopilotUpstream({
      model: "m",
      apiBase: () => Promise.resolve(API_BASE),
      sessionToken: () => {
        const token = `session-${issued.length + 1}`;
        issued.push(token);
        return token;
      },
      githubToken: () => "gho_rotating",
    });
    const first = ok(await rotating.writeUpstreamRequest(fullRequest()));
    const second = ok(await rotating.writeUpstreamRequest(fullRequest()));

    expect(first.headers["copilot-session-token"]).toBe("session-1");
    expect(second.headers["copilot-session-token"]).toBe("session-2");
    // 凭据换了，body 一个字节都不该动。
    expect(second.body).toBe(first.body);
  });

  it("凭据取不到是抛，不是「成功但打不通」的 wire", async () => {
    for (const field of ["apiBase", "sessionToken", "githubToken"] as const) {
      const broken = createCopilotUpstream({
        model: "m", apiBase: API_BASE, sessionToken: "s", githubToken: "g",
        [field]: () => "   ",
      });
      await expect(broken.writeUpstreamRequest(fullRequest())).rejects.toThrow(`options.${field}`);
    }
  });

  it("编不出 wire 的请求不去刷 token —— 拒绝先于凭据解析", async () => {
    let resolved = 0;
    const counting = createCopilotUpstream({
      model: "m", apiBase: API_BASE, githubToken: "g",
      sessionToken: () => { resolved += 1; return "s"; },
    });
    const { request } = readChatCompletionsRequest({
      model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }],
    }, TRACE);
    expect(rejected(await counting.writeUpstreamRequest(request))).toHaveLength(1);
    expect(resolved).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("投影只有一份", () => {
  it("除 model 外与原生 Anthropic 逐字节相同 —— 谁复制一份投影，这条当场红", async () => {
    const native = createAnthropicUpstream({
      baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test", model: "claude-opus-5-copilot",
    });
    const request = fullRequest();
    const copilotBody = ok(await egress.writeUpstreamRequest(request)).body;
    const nativeBody = ok(await native.writeUpstreamRequest(request)).body;
    expect(copilotBody).toBe(nativeBody);
  });

  it("body 逐字段：位置不变量、工具、思考、缓存断点都由共享投影产出", async () => {
    const body = bodyOf(await egress.writeUpstreamRequest(fullRequest()));

    expect(body.model).toBe("claude-opus-5-copilot");
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.3);
    expect(body.stop_sequences).toEqual(["</done>"]);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(body.system).toEqual([
      { type: "text", text: "you are a gateway", cache_control: { type: "ephemeral" } },
    ]);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    // 工具结果按 assistant 的调用顺序重铺到紧随的 user 回合最前 —— [text, tool_result] 顺序上游必拒。
    const last = messages[2]?.content as Array<Record<string, unknown>>;
    expect(last.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(last.map((block) => block.tool_use_id)).toEqual(["toolu_1", "toolu_2", undefined]);
    expect(last[0]?.is_error).toBe(true);
    // 带 signature 的思考块原样回传：2959 个生产思考块全部带它，丢了上游会拒。
    const assistant = messages[1]?.content as Array<Record<string, unknown>>;
    expect(assistant[0]).toEqual({ type: "thinking", thinking: "let me look", signature: "sig-1" });
  });

  it("确定性：同一个 IR 连续构造两次，wire 字节完全相同", async () => {
    const request = fullRequest();
    const first = ok(await egress.writeUpstreamRequest(request));
    const second = ok(await egress.writeUpstreamRequest(request));
    expect(second.body).toBe(first.body);
    expect(second).toEqual(first);
    // 两个独立 decode 出来的等价 IR 也必须编译成同一份字节。
    expect(ok(await egress.writeUpstreamRequest(fullRequest())).body).toBe(first.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("拒绝条件与原生 Anthropic 一致", () => {
  const native = createAnthropicUpstream({
    baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude-opus-5-copilot",
  });

  const cases: ReadonlyArray<{ readonly why: string; readonly build: () => IRRequest }> = [
    {
      why: "客户端没给 max_tokens",
      build: () => readChatCompletionsRequest(
        { model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }, TRACE,
      ).request,
    },
    {
      why: "悬空工具调用",
      build: () => readAnthropicMessagesRequest({
        model: "m", max_tokens: 8,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_missing", name: "Bash", input: {} }] },
        ],
      }, TRACE).request,
    },
    {
      why: "孤儿工具结果",
      build: () => readAnthropicMessagesRequest({
        model: "m", max_tokens: 8,
        messages: [{ role: "user", content: [
          { type: "text", text: "resuming" },
          { type: "tool_result", tool_use_id: "toolu_orphan", content: "leftover" },
        ] }],
      }, TRACE).request,
    },
    {
      why: "全空会话",
      build: () => readAnthropicMessagesRequest({
        model: "m", max_tokens: 8,
        messages: [{ role: "user", content: "" }, { role: "assistant", content: [] }],
      }, TRACE).request,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.why}：与 anthropic 出口给出同一组 kind@path`, async () => {
      const request = testCase.build();
      const mine = rejected(await egress.writeUpstreamRequest(request));
      const theirs = rejected(await native.writeUpstreamRequest(request));
      expect(mine.map((problem) => `${problem.kind}@${problem.path}`))
        .toEqual(theirs.map((problem) => `${problem.kind}@${problem.path}`));
      expect(mine.length).toBeGreaterThan(0);
    });
  }

  it("拒绝时已攒下的 loss 一并交出，且 provider 记的是 copilot", async () => {
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
    expect(result.losses[0]?.provider).toBe("copilot");
    expect(result.losses[0]?.stage).toBe("egress");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("方言复核：两条有实证的差别", () => {
  function withContextManagement(): IRRequest {
    return readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      messages: [{ role: "user", content: "go" }],
    }, TRACE).request;
  }

  it("context_management 必删并留痕 —— 带着它 400，去掉它 200（2026-07-27 canary）", async () => {
    const request = withContextManagement();
    expect(request.intent.contextEdits).toHaveLength(1);

    const result = await egress.writeUpstreamRequest(request);
    const body = bodyOf(result);
    expect("context_management" in body).toBe(false);
    // 删了必须看得见：147/606 条真实流量带它，静默删掉就没人知道上游少了这道裁剪。
    if (!result.ok) throw new Error("expected ok");
    expect(result.losses).toEqual([{
      stage: "egress",
      provider: "copilot",
      path: "$.intent.contextEdits",
      kind: "dropped",
      detail: expect.stringContaining("context_management"),
    }]);
  });

  it("同一条请求走原生 Anthropic 时 context_management 照发 —— 差别是 Copilot 的，不是投影的", async () => {
    const native = createAnthropicUpstream({ baseUrl: API_BASE, apiKey: "k", model: "m" });
    const body = bodyOf(await native.writeUpstreamRequest(withContextManagement()));
    expect(body.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  });

  it("computer_* 内建工具带精确路径拒绝，而不是换回一个语义模糊的 400", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      tools: [
        { name: "Read", description: "read", input_schema: { type: "object" } },
        { type: "computer_20251124", name: "computer", display_width_px: 1280, display_height_px: 800 },
      ],
      messages: [{ role: "user", content: "go" }],
    }, TRACE);
    const problems = rejected(await egress.writeUpstreamRequest(request));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("unrepresentablePart");
    expect(problems[0]?.path).toBe("$.conversation.toolset.tools[1]");
    expect(problems[0]?.detail).toContain("computer_20251124");
  });

  it("上游白名单里的内建工具照常编译 —— 拒的是 computer_*，不是内建工具本身", async () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
      ],
      messages: [{ role: "user", content: "go" }],
    }, TRACE);
    const body = bodyOf(await egress.writeUpstreamRequest(request));
    expect(body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search" },
      { type: "bash_20250124", name: "bash" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("能力声明", () => {
  it("supports 与 lossy 不相交，且合起来不多不少覆盖每一个 IRCapability", () => {
    const { supports, lossy } = egress.profile;
    expect(egress.profile.provider).toBe("copilot");
    for (const capability of supports) expect(lossy.has(capability)).toBe(false);
    // 一个能力落在两个集合之外 = 准入直接判这家不可用。Copilot 是 Anthropic wire，
    // 没有任何一个能力该落到那里 —— 真正拒的是具体的 computer_* 工具，在写出层。
    expect(supports.size + lossy.size).toBe(27);
  });

  it("与原生 Anthropic 的差异清单固定在这里 —— 每一条都有 Copilot 侧的独立实证", () => {
    const native = createAnthropicUpstream({ baseUrl: API_BASE, apiKey: "k", model: "m" }).profile;
    const mine = egress.profile;

    // 原生 supports 而 Copilot 不 supports 的：全部有 Copilot 侧的实证或零观测。
    const downgraded = [...native.supports].filter((capability) => !mine.supports.has(capability)).sort();
    const expected: IRCapability[] = [
      // 606 条生产 Copilot 请求里 0 个 document 块。
      "document",
      // 观测到被 400 拒（"Extra inputs are not permitted"），必删。
      "contextEdit",
      // 0 条 thinking:{type:'enabled',budget_tokens}。
      "reasoningBudget",
      // 0 条 service_tier（共享投影本来也不写这个字段）。
      "serviceTier",
      // 各 0 条。
      "topK", "topP",
    ];
    expect(downgraded).toEqual(expected.sort());
    // 反过来没有：Copilot 不会比原生多支持任何东西。
    expect([...mine.supports].filter((capability) => !native.supports.has(capability))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("readUpstreamResponse：与 Anthropic 同一条 wire", () => {
  function sse(...frames: readonly string[]): Response {
    return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  }

  async function collect(response: Response): Promise<IREvent[]> {
    const events: IREvent[] = [];
    for await (const event of egress.readUpstreamResponse(response)) events.push(event);
    return events;
  }

  async function errorOf(response: Response): Promise<IRUpstreamError> {
    const events = await collect(response);
    const failure = events.find((event) => event.kind === "error");
    if (failure === undefined) throw new Error(`expected an error event, got ${JSON.stringify(events)}`);
    return failure.error;
  }

  it("完整流：messageStart → part → usage → messageStop", async () => {
    const events = await collect(sse(
      JSON.stringify({ type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 3 } }),
    ));
    expect(events.map((event) => event.kind)).toEqual([
      "messageStart", "usage", "partStart", "partDelta", "partEnd", "usage", "messageStop",
    ]);
    expect(events.some((event) => event.kind === "unhandled")).toBe(false);
  });

  it("Copilot 往 message_delta 里混的 copilot_usage 不打断解析 —— 计费不是 IR 的事", async () => {
    // 上游在 Anthropic Message 里塞自家计费块（total_nano_aiu）。IR 里没有它的位置，
    // 而 agent-ir 的边界本来就不含配额与计费 —— 顶层多一个键，事件序不受影响。
    const events = await collect(sse(
      JSON.stringify({ type: "message_start", message: { model: "claude-opus-5" } }),
      JSON.stringify({
        type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 7, output_tokens: 2 },
        copilot_usage: { total_nano_aiu: 12345 },
      }),
    ));
    expect(events.map((event) => event.kind)).toEqual(["messageStart", "usage", "messageStop"]);
    const usage = events.find((event) => event.kind === "usage");
    expect(usage?.kind === "usage" ? usage.usage.inputTokens : null).toBe(7);
  });

  it("流被掐断没有终止帧：产出 error 而不是安静收尾成「200 但空」", async () => {
    const events = await collect(sse(
      JSON.stringify({ type: "message_start", message: { model: "claude-opus-5" } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half a sen" } }),
    ));
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);
    const failure = events[events.length - 1];
    expect(failure?.kind).toBe("error");
    if (failure?.kind !== "error") return;
    expect(failure.error.kind).toBe("transport");
    expect(failure.error.retryable).toBe(true);
    expect(failure.error.message).toContain("terminal event");
  });

  it("上游 4xx/5xx 分类：判别位取 error.type，httpStatus 原样留给调用方", async () => {
    const cases: ReadonlyArray<{
      readonly status: number; readonly type: string;
      readonly kind: IRUpstreamError["kind"]; readonly retryable: boolean;
    }> = [
      { status: 400, type: "invalid_request_error", kind: "invalidRequest", retryable: false },
      // Copilot 的 session token 过期 / 套餐无权 → 调用方该换号而不是重试同一个。
      { status: 401, type: "authentication_error", kind: "permissionDenied", retryable: false },
      { status: 403, type: "permission_error", kind: "permissionDenied", retryable: false },
      { status: 429, type: "rate_limit_error", kind: "rateLimited", retryable: true },
      { status: 503, type: "overloaded_error", kind: "upstreamUnavailable", retryable: true },
    ];
    for (const testCase of cases) {
      const error = await errorOf(new Response(
        JSON.stringify({ type: "error", error: { type: testCase.type, message: "nope" } }),
        { status: testCase.status, headers: { "content-type": "application/json" } },
      ));
      expect(error.kind).toBe(testCase.kind);
      expect(error.httpStatus).toBe(testCase.status);
      expect(error.retryable).toBe(testCase.retryable);
    }
  });

  it("非 JSON 的 5xx（网关 HTML 之类）仍是一条 error，原文进 raw", async () => {
    const error = await errorOf(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(error.httpStatus).toBe(502);
    expect(error.raw).toBe("<html>502 Bad Gateway</html>");
    // 判别位取不到就是 unknown —— 不猜、也不静默成功。
    expect(error.kind).toBe("unknown");
  });

  it("非流式：一次性 Message JSON 折成等价事件序列", async () => {
    const events = await collect(new Response(JSON.stringify({
      type: "message", model: "claude-opus-5", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_9", name: "Read", input: { path: "a" } }],
      usage: { input_tokens: 5, output_tokens: 1 },
      copilot_usage: { total_nano_aiu: 99 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(events.map((event) => event.kind)).toEqual([
      "messageStart", "partStart", "partEnd", "usage", "messageStop",
    ]);
    const stop = events[events.length - 1];
    expect(stop?.kind === "messageStop" ? stop.reason : null).toBe("toolUse");
  });
});
