/**
 * OpenAI Responses 出口的 lower / lift。
 *
 * 报文形状全部取自真实来源，不写臆想用例：
 *   - 请求侧：80 条归档 `/v1/responses` 请求（`{type:'namespace', name, description, tools:[…]}`、
 *     `{type:'web_search', external_web_access:false}`、`reasoning:{effort,summary}`、
 *     `include:['reasoning.encrypted_content']`、`store:false`）
 *   - input item：94 份 codex rollout（reasoning 10204 / custom_tool_call 7901 /
 *     custom_tool_call_output 7901 / function_call 1176（其中 872 条带 `namespace`）/
 *     function_call_output 1176；输出既有 string 也有 input_text 数组）
 *   - 事件流：PROTOCOL_REFERENCE §11 的真实抓包序列 + codex_provider.ts 里踩过坑的
 *     `keepalive` / `response.failed` / 顶层 `error` 三例
 */
import { describe, expect, it } from "bun:test";
import { createResponsesUpstream } from "../src/egress/openai_responses.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { checkUpstreamSupport } from "../src/ir/admission.ts";
import { assembleResponse } from "../src/ir/response.ts";
import {
  clientValue, defaultValue,
  type IRBuildProblem, type IRConversation, type IREvent, type IRIntent, type IRPart, type IRRequest,
  type IRToolset, type IRTurn,
} from "../src/ir/types.ts";

const egress = createResponsesUpstream({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-5.6-sol",
});

// ── 构造 IR ────────────────────────────────────────────────────────────────

const emptyToolset: IRToolset = {
  tools: [], groups: [],
  choice: defaultValue({ kind: "auto" }),
  parallel: defaultValue(true),
};

function makeRequest(input: {
  system?: readonly IRPart[];
  turns?: readonly IRTurn[];
  toolset?: IRToolset;
  intent?: Partial<IRIntent>;
}): IRRequest {
  const conversation: IRConversation = {
    system: input.system ?? [],
    turns: input.turns ?? [],
    toolset: input.toolset ?? emptyToolset,
  };
  const intent: IRIntent = {
    reasoning: defaultValue({ mode: "auto", display: "summarized" }),
    outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"),
    sampling: {},
    stopping: {},
    contextEdits: [],
    stream: defaultValue(true),
    identity: {},
    ...input.intent,
  };
  const partial = {
    traceId: "tr-egress", protocol: "openai_responses" as const, model: "client-model",
    conversation, intent,
  };
  return { ...partial, requires: deriveCapabilityNeeds(partial) };
}

/**
 * `writeUpstreamRequest` 是**编译或拒绝**的判别联合。成功用例统一从这里剥出 wire ——
 * 万一被拒，失败信息里直接是 problems，而不是一句「wire is undefined」。
 */
async function lowerBody(request: IRRequest): Promise<{
  readonly body: Record<string, unknown>;
  readonly items: Array<Record<string, unknown>>;
  readonly losses: readonly { path: string; kind: string; detail: string }[];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}> {
  const lowered = await egress.writeUpstreamRequest(request);
  if (!lowered.ok) throw new Error(`expected a compiled request, got problems: ${JSON.stringify(lowered.problems)}`);
  const body = JSON.parse(lowered.wire.body) as Record<string, unknown>;
  return {
    body,
    items: body.input as Array<Record<string, unknown>>,
    losses: lowered.losses.map((loss) => ({ path: loss.path, kind: loss.kind, detail: loss.detail })),
    url: lowered.wire.url,
    headers: lowered.wire.headers,
    rawBody: lowered.wire.body,
  };
}

/** 期望拒绝。返回 problems 与拒绝前已记下的 losses（契约要求两者一并交出）。 */
async function rejected(request: IRRequest): Promise<{
  readonly problems: readonly IRBuildProblem[];
  readonly losses: readonly { path: string; kind: string; detail: string }[];
}> {
  const lowered = await egress.writeUpstreamRequest(request);
  if (lowered.ok) throw new Error(`expected a rejection, got a wire: ${lowered.wire.body}`);
  return {
    problems: lowered.problems,
    losses: lowered.losses.map((loss) => ({ path: loss.path, kind: loss.kind, detail: loss.detail })),
  };
}

// ── 构造上游响应 ────────────────────────────────────────────────────────────

function sse(frames: ReadonlyArray<Record<string, unknown>>): Response {
  const body = frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(response: Response): Promise<IREvent[]> {
  const events: IREvent[] = [];
  for await (const event of egress.readUpstreamResponse(response)) events.push(event);
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
describe("能力声明", () => {
  it("分组与 freeform 是 supports 而不是 lossy —— 这正是这个出口存在的理由", () => {
    // Anthropic 出口只能把 namespace 拍进名字、把 freeform 包成单字段 schema，两者都记 lossy。
    // Responses 两者都有原生载体：定义侧 {type:'namespace'} / {type:'custom'}，
    // 调用侧 function_call.namespace / custom_tool_call.input。
    expect(egress.profile.supports.has("toolGroup")).toBe(true);
    expect(egress.profile.supports.has("toolFreeform")).toBe(true);
    expect(egress.profile.lossy.has("toolGroup")).toBe(false);
    expect(egress.profile.lossy.has("toolFreeform")).toBe(false);
  });

  it("没核实过形状的一律不进 supports：stopSequences / topK / reasoningBudget", () => {
    for (const capability of ["stopSequences", "topK", "reasoningBudget", "thinkingSignature"] as const) {
      expect(egress.profile.supports.has(capability)).toBe(false);
      expect(egress.profile.lossy.has(capability)).toBe(true);
    }
    // document 没有经验证的 wire 载体，必须在准入层拒绝。
    expect(egress.profile.supports.has("document")).toBe(false);
    expect(egress.profile.lossy.has("document")).toBe(false);
    // function_call_output 原生接受 input_image；图像工具结果无需降级。
    expect(egress.profile.supports.has("toolResultImage")).toBe(true);
    expect(egress.profile.lossy.has("toolResultImage")).toBe(false);
    // supports 与 lossy 不相交，否则 admission 的三条规则会退化成两条。
    for (const capability of egress.profile.supports) expect(egress.profile.lossy.has(capability)).toBe(false);
  });

  it("含分组 + freeform 工具的请求直接放行，且不产生 admission loss", () => {
    const request = makeRequest({
      toolset: {
        tools: [
          { kind: "function", ref: { group: "collaboration", name: "send_message" }, description: "", schema: { type: "object" } },
          { kind: "freeform", ref: { group: null, name: "apply_patch" }, description: "" },
        ],
        groups: [{ name: "collaboration", members: ["send_message"] }],
        choice: defaultValue({ kind: "auto" }),
        parallel: defaultValue(true),
      },
    });
    const verdict = checkUpstreamSupport(request, egress.profile);
    expect(verdict.admitted).toBe(true);
    expect(verdict.losses).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lower：会话 → 扁平 item 序列", () => {
  const conversation = makeRequest({
    system: [{ kind: "text", text: "You are Codex." }],
    turns: [
      { role: "user", parts: [{ kind: "text", text: "check two things" }] },
      { role: "assistant", parts: [
        { kind: "thinking", text: "plan it" },
        { kind: "redactedThinking", data: "gAAAAABqcDx8" },
        { kind: "text", text: "running both" },
        // 语料实证并行调用是常态（最高 9 个）。
        { kind: "toolCall", call: { id: "call_a", toolRef: { group: null, name: "exec_command" }, input: { kind: "json", value: { cmd: "pwd" } } } },
        { kind: "toolCall", call: { id: "call_b", toolRef: { group: "collaboration", name: "send_message" }, input: { kind: "json", value: { target: "/root" } } } },
        { kind: "toolCall", call: { id: "call_c", toolRef: { group: null, name: "apply_patch" }, input: { kind: "text", text: "*** Begin Patch" } } },
      ] },
      { role: "user", parts: [
        { kind: "toolResult", result: { callId: "call_a", parts: [{ kind: "text", text: "/home" }], status: "ok" } },
        // 以前这里是 `parts: []` —— 空结果现在会被拒（补正文是策略），
        // 而这条用例要验的是配对与顺序，所以给它一句真实内容。
        { kind: "toolResult", result: { callId: "call_b", parts: [{ kind: "text", text: "sent" }], status: "ok" } },
        { kind: "toolResult", result: { callId: "call_c", parts: [{ kind: "text", text: "applied" }], status: "ok" } },
        { kind: "text", text: "now summarise" },
      ] },
    ],
    toolset: {
      tools: [
        { kind: "function", ref: { group: null, name: "exec_command" }, description: "Runs a command in a PTY.", schema: { type: "object", properties: {} } },
        { kind: "function", ref: { group: "collaboration", name: "send_message" }, description: "Send a message.", schema: { type: "object" } },
        { kind: "freeform", ref: { group: null, name: "apply_patch" }, description: "Apply a patch." },
        { kind: "builtin", ref: { group: null, name: "web_search" }, builtin: "web_search", config: { external_web_access: false } },
      ],
      groups: [{ name: "collaboration", members: ["send_message"] }],
      choice: clientValue({ kind: "auto" }),
      parallel: clientValue(true),
    },
  });

  it("system 走 instructions，input 是扁平序列而不是 message 序列", async () => {
    const { body, items, url, headers } = await lowerBody(conversation);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers.accept).toBe("text/event-stream");
    expect(body.instructions).toBe("You are Codex.");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.store).toBe(false);

    // 并行调用保持 IR 的原始顺序：三个调用连着发，三个输出连着回。Responses 的 item 序列
    // 没有 Anthropic 那套「结果必须紧邻且最前」的排列规则，所以这里不做任何重排。
    expect(items.map((item) => item.type)).toEqual([
      "message",                 // user
      "reasoning",               // thinking + encrypted_content 合成一条
      "message",                 // assistant 正文
      "function_call",           // exec_command
      "function_call",           // collaboration/send_message
      "custom_tool_call",        // apply_patch（freeform）
      "function_call_output",
      "function_call_output",
      "custom_tool_call_output",
      "message",                 // 尾随的用户正文
    ]);
  });

  it("调用与输出严格配对：freeform 调用配 custom_tool_call_output，不是 function_call_output", async () => {
    const { items } = await lowerBody(conversation);
    const pairs = items
      .filter((item) => String(item.type).includes("tool_call") || String(item.type).includes("function_call"))
      .map((item) => `${String(item.type)}:${String(item.call_id)}`);
    expect(pairs).toEqual([
      "function_call:call_a", "function_call:call_b", "custom_tool_call:call_c",
      "function_call_output:call_a", "function_call_output:call_b", "custom_tool_call_output:call_c",
    ]);
  });

  it("分组是 function_call 上的结构化 namespace 字段，不是名字前缀", async () => {
    const { items } = await lowerBody(conversation);
    const grouped = items.find((item) => item.call_id === "call_b");
    expect(grouped?.name).toBe("send_message");
    expect(grouped?.namespace).toBe("collaboration");
    // 拍平的话名字会变成 collaboration__send_message —— 那正是 Anthropic 出口的有损做法。
    expect(String(grouped?.name)).not.toContain("__");
  });

  it("freeform 调用的入参是自由文本，不被包成 JSON", async () => {
    const { items } = await lowerBody(conversation);
    const freeform = items.find((item) => item.type === "custom_tool_call");
    expect(freeform?.input).toBe("*** Begin Patch");
    expect(freeform?.arguments).toBeUndefined();
  });

  it("reasoning item 合回一条，encrypted_content 原样回传", async () => {
    const { items } = await lowerBody(conversation);
    const reasoning = items.find((item) => item.type === "reasoning");
    expect(reasoning?.encrypted_content).toBe("gAAAAABqcDx8");
    expect(reasoning?.summary).toEqual([{ type: "summary_text", text: "plan it" }]);
  });

  it("工具定义：分组进 namespace、freeform 进 custom、内建保留 config 且不强塞 name", async () => {
    const { body } = await lowerBody(conversation);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.type)).toEqual(["function", "custom", "web_search", "namespace"]);

    const namespace = tools.find((tool) => tool.type === "namespace");
    expect(namespace?.name).toBe("collaboration");
    expect((namespace?.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toEqual(["send_message"]);

    const custom = tools.find((tool) => tool.type === "custom");
    expect(custom).toEqual({ type: "custom", name: "apply_patch", description: "Apply a patch." });

    // 实测 `{type:'web_search', external_web_access:false}` 就是没有 name 的。
    expect(tools.find((tool) => tool.type === "web_search")).toEqual({ type: "web_search", external_web_access: false });
  });

  it("整条链路零损失：分组与 freeform 都没被降级", async () => {
    const { losses } = await lowerBody(conversation);
    expect(losses).toHaveLength(0);
  });

  it("正常请求 ok:true，wire 逐字段锁死", async () => {
    const { body, url, headers, rawBody } = await lowerBody(makeRequest({
      system: [{ kind: "text", text: "You are Codex." }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: { stopping: { maxOutputTokens: clientValue(256) } },
    }));
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      accept: "text/event-stream",
    });
    expect(body).toEqual({
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
      instructions: "You are Codex.",
      reasoning: { summary: "auto" },
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 256,
    });
    expect(rawBody.length).toBeGreaterThan(0);
  });

  it("确定性：同一个 IR 连续构造两次，body 字节完全相同", async () => {
    const request = makeRequest({
      system: [{ kind: "text", text: "You are Codex." }],
      turns: [
        { role: "user", parts: [{ kind: "text", text: "go" }] },
        { role: "assistant", parts: [
          { kind: "toolCall", call: { id: "call_a", toolRef: { group: "collaboration", name: "send_message" }, input: { kind: "json", value: { target: "/root" } } } },
        ] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "call_a", parts: [{ kind: "text", text: "done" }], status: "ok" } },
        ] },
      ],
      toolset: {
        tools: [{ kind: "function", ref: { group: "collaboration", name: "send_message" }, description: "", schema: { type: "object" } }],
        groups: [{ name: "collaboration", members: ["send_message"] }],
        choice: clientValue({ kind: "auto" }),
        parallel: clientValue(true),
      },
    });
    const first = await lowerBody(request);
    const second = await lowerBody(request);
    expect(second.rawBody).toBe(first.rawBody);
    expect(second.losses).toEqual(first.losses);
  });

  it("非文本 system 部分退到 role:'developer' 的 message item，与 instructions 共存", async () => {
    const { body, items } = await lowerBody(makeRequest({
      system: [
        { kind: "text", text: "sys text" },
        { kind: "image", media: { source: { kind: "base64", data: "AAA" }, mediaType: "image/png" } },
      ],
    }));
    expect(body.instructions).toBe("sys text");
    expect(items[0]).toEqual({
      type: "message", role: "developer",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("会话身份：承载得了的发，承载不了的留痕", () => {
  it("sessionId → prompt_cache_key（实测这就是会话 uuid），没有多余的 loss", async () => {
    const { body, losses } = await lowerBody(makeRequest({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: { identity: { sessionId: "sess-42" } },
    }));
    expect(body.prompt_cache_key).toBe("sess-42");
    expect(losses.filter((loss) => loss.path === "$.intent.identity")).toEqual([]);
  });

  it("device_id / account_uuid 没有位置：不塞进 `user`，各记一条 loss", async () => {
    const { body, losses } = await lowerBody(makeRequest({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: { identity: { sessionId: "sess-42", deviceId: "dev-1", accountUuid: "acct-1" } },
    }));
    expect(body.prompt_cache_key).toBe("sess-42");
    expect(Object.hasOwn(body, "user")).toBe(false);
    expect(losses).toContainEqual(expect.objectContaining({ path: "$.intent.identity", kind: "dropped" }));
    expect(JSON.stringify(body)).not.toContain("dev-1");
    expect(JSON.stringify(body)).not.toContain("acct-1");
  });

  it("必填字段：/v1/responses 不要求 max_output_tokens", () => {
    expect(egress.profile.mandatory.maxOutputTokens).toBe(false);
  });
});

describe("lower：损失必须留痕", () => {
  // 旧行为：悬空调用补一条占位 output、孤儿结果直接丢，各记一条 loss。两者都是
  // 「网关替客户端决定」，已剥离到 src/repair —— Core 现在只拒绝，并且一次收齐。
  it("悬空调用与孤儿结果一次全收集地拒绝，路径指到具体 part", async () => {
    const { problems } = await rejected(makeRequest({
      turns: [
        { role: "assistant", parts: [
          { kind: "toolCall", call: { id: "call_dangling", toolRef: { group: null, name: "T" }, input: { kind: "json", value: {} } } },
        ] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "call_orphan", parts: [{ kind: "text", text: "x" }], status: "ok" } },
        ] },
      ],
    }));
    expect(problems).toHaveLength(2);

    const dangling = problems.find((problem) => problem.kind === "danglingToolCall");
    expect(dangling?.path).toBe("$.conversation.turns[0].parts[0]");
    expect(dangling?.detail).toContain("call_dangling");
    expect(dangling?.detail).toContain("fillDanglingToolCall");

    const orphan = problems.find((problem) => problem.kind === "orphanToolResult");
    expect(orphan?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(orphan?.detail).toContain("call_orphan");
    expect(orphan?.detail).toContain("dropOrphanToolResult");
  });

  it("空工具输出拒绝：以前补一个空 input_text，等于替客户端宣布工具跑成功了", async () => {
    const { problems } = await rejected(makeRequest({
      turns: [
        { role: "assistant", parts: [{ kind: "toolCall", call: { id: "c1", toolRef: { group: null, name: "T" }, input: { kind: "json", value: {} } } }] },
        { role: "user", parts: [{ kind: "toolResult", result: { callId: "c1", parts: [], status: "ok" } }] },
      ],
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(problems[0]?.detail).toContain("fillEmptyToolResult");
  });

  it("多个问题混在一条请求里全部收齐，不短路", async () => {
    const { problems } = await rejected(makeRequest({
      turns: [
        { role: "user", parts: [
          { kind: "document", media: { source: { kind: "base64", data: "JVBER" }, mediaType: "application/pdf" } },
        ] },
        { role: "assistant", parts: [
          { kind: "toolCall", call: { id: "call_dangling", toolRef: { group: null, name: "T" }, input: { kind: "json", value: {} } } },
        ] },
      ],
      intent: { outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }) },
    }));
    expect(problems.map((problem) => problem.kind).sort()).toEqual(
      ["danglingToolCall", "requiredFieldMissing", "unrepresentablePart"]);
    expect(problems.map((problem) => problem.path).sort()).toEqual([
      "$.conversation.turns[0].parts[0]",
      "$.conversation.turns[1].parts[0]",
      "$.intent.outputFormat",
    ]);
  });

  it("工具结果的错误位没有载体：错误性写进正文并记 degraded", async () => {
    const { items, losses } = await lowerBody(makeRequest({
      turns: [
        { role: "assistant", parts: [{ kind: "toolCall", call: { id: "c1", toolRef: { group: null, name: "T" }, input: { kind: "json", value: {} } } }] },
        { role: "user", parts: [{ kind: "toolResult", result: { callId: "c1", parts: [{ kind: "text", text: "boom" }], status: "error" } }] },
      ],
    }));
    const output = items.find((item) => item.type === "function_call_output");
    expect(output?.output).toEqual([
      { type: "input_text", text: "[gateway: this tool call failed]" },
      { type: "input_text", text: "boom" },
    ]);
    expect(losses.some((loss) => loss.kind === "degraded" && loss.detail.includes("no error flag"))).toBe(true);
  });

  it("工具结果里的图片保留为 input_image，不降级成文本", async () => {
    const { items } = await lowerBody(makeRequest({
      turns: [
        { role: "assistant", parts: [{ kind: "toolCall", call: { id: "c1", toolRef: { group: null, name: "T" }, input: { kind: "json", value: {} } } }] },
        { role: "user", parts: [{ kind: "toolResult", result: {
          callId: "c1",
          parts: [{ kind: "image", media: { source: { kind: "base64", data: "AAA" }, mediaType: "image/png" } }],
          status: "ok",
        } }] },
      ],
    }));
    const output = items.find((item) => item.type === "function_call_output");
    expect(output?.output).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AAA" }]);
  });

  it("文档拒绝：input_file 的形状从未在真实报文里出现过，占位文本不等于送到了", async () => {
    const { problems } = await rejected(makeRequest({
      turns: [{ role: "user", parts: [
        { kind: "document", media: { source: { kind: "base64", data: "JVBER" }, mediaType: "application/pdf" }, title: "spec" },
      ] }],
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("unrepresentablePart");
    expect(problems[0]?.path).toBe("$.conversation.turns[0].parts[0]");
    expect(problems[0]?.detail).toContain("application/pdf");
    expect(problems[0]?.detail).toContain("textualizeUnsupportedDocument");
  });

  it("客户端给了 json_schema 的 name 就照发；没给则拒绝，不替它取名", async () => {
    const named = await lowerBody(makeRequest({
      intent: { outputFormat: clientValue({ kind: "jsonSchema", name: "verdict", schema: { type: "object" }, strict: true }) },
    }));
    expect(named.body.text).toEqual({
      format: { type: "json_schema", name: "verdict", schema: { type: "object" }, strict: true },
    });

    const { problems } = await rejected(makeRequest({
      intent: { outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }) },
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.intent.outputFormat");
    expect(problems[0]?.detail).toContain("text.format.json_schema");
  });

  it("thinking 只有签名没有 encrypted_content 时整条 reasoning 丢弃 —— 两条独立留痕", async () => {
    const { items, losses } = await lowerBody(makeRequest({
      turns: [{ role: "assistant", parts: [{ kind: "thinking", text: "anthropic thought", signature: "sig-xyz" }] }],
    }));
    expect(items.some((item) => item.type === "reasoning")).toBe(false);
    expect(losses.some((loss) => loss.detail.includes("thinking signature has no carrier"))).toBe(true);
    expect(losses.some((loss) => loss.detail.includes("without encrypted_content"))).toBe(true);
  });

  it("budget_tokens 折算成 effort 档并记 substituted（Responses 没有 token 预算参数）", async () => {
    const { body, losses } = await lowerBody(makeRequest({
      intent: { reasoning: clientValue({ mode: "enabled", budgetTokens: 10000, display: "summarized" }) },
    }));
    expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(losses.some((loss) => loss.kind === "substituted" && loss.detail.includes("budget_tokens=10000"))).toBe(true);
  });

  it("effort 'max' 夹到 'high'，display 'full' 记 degraded，'hidden' 不记（默认就是不返摘要）", async () => {
    const clamped = await lowerBody(makeRequest({
      intent: { reasoning: clientValue({ mode: "enabled", effort: "max", display: "full" }) },
    }));
    expect(clamped.body.reasoning).toEqual({ effort: "high", summary: "detailed" });
    expect(clamped.losses.map((loss) => loss.kind).sort()).toEqual(["degraded", "substituted"]);
    // 夹档留痕的 detail 必须**同时**含原值与夹后值，否则日志里还原不出客户端要的档位。
    const clampLoss = clamped.losses.find((loss) => loss.path === "$.intent.reasoning.effort");
    expect(clampLoss?.kind).toBe("substituted");
    expect(clampLoss?.detail).toContain("'max'");   // 原值
    expect(clampLoss?.detail).toContain("'high'");  // 夹后值

    // 另一档越界值同样留痕：判断由 `EFFORT_WIRE` 派生，不是手写的档位清单。
    const xhigh = await lowerBody(makeRequest({
      intent: { reasoning: clientValue({ mode: "enabled", effort: "xhigh", display: "summarized" }) },
    }));
    expect(xhigh.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    const xhighLoss = xhigh.losses.find((loss) => loss.path === "$.intent.reasoning.effort");
    expect(xhighLoss?.kind).toBe("substituted");
    expect(xhighLoss?.detail).toContain("'xhigh'");
    expect(xhighLoss?.detail).toContain("'high'");

    const hidden = await lowerBody(makeRequest({
      intent: { reasoning: clientValue({ mode: "enabled", effort: "high", display: "hidden" }) },
    }));
    expect(hidden.body.reasoning).toEqual({ effort: "high" });
    expect(hidden.losses).toHaveLength(0);
  });

  it("stop_sequences / top_k / context_management / cache_control 各记一条，且都不出现在 wire 上", async () => {
    const { body, losses } = await lowerBody(makeRequest({
      system: [{ kind: "text", text: "s", cacheBreakpoint: { scope: "ephemeral" } }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "u", cacheBreakpoint: { scope: "ephemeral" } }] }],
      intent: {
        stopping: { stopSequences: clientValue(["STOP"]) },
        sampling: { topK: clientValue(40) },
        contextEdits: [{ kind: "clearThinking", keep: "all", raw: { type: "clear_thinking_20251015" } }],
      },
    }));
    expect(body.stop).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("cache_control");
    const details = losses.map((loss) => loss.detail).join(" | ");
    expect(details).toContain("no stop parameter");
    expect(details).toContain("top_k has no equivalent");
    expect(details).toContain("context edit instruction");
    expect(details).toContain("2 ephemeral cache breakpoint(s)");
  });

  it("标准 /v1/responses 接受 max_output_tokens：照发不记损失（私有 codex 端点才拒收）", async () => {
    const { body, losses } = await lowerBody(makeRequest({
      intent: { stopping: { maxOutputTokens: clientValue(4096) } },
    }));
    expect(body.max_output_tokens).toBe(4096);
    expect(losses).toHaveLength(0);
    expect(egress.profile.supports.has("maxOutputTokens")).toBe(true);
  });

  it("tool_choice 指定 freeform 工具时用 {type:'custom'}，指定分组工具时带 namespace", async () => {
    const tools = [
      { kind: "freeform" as const, ref: { group: null, name: "apply_patch" }, description: "" },
      { kind: "function" as const, ref: { group: "collaboration", name: "send_message" }, description: "", schema: {} },
    ];
    const custom = await lowerBody(makeRequest({
      toolset: { tools, groups: [], choice: clientValue({ kind: "specific", ref: { group: null, name: "apply_patch" } }), parallel: defaultValue(true) },
    }));
    expect(custom.body.tool_choice).toEqual({ type: "custom", name: "apply_patch" });

    const grouped = await lowerBody(makeRequest({
      toolset: { tools, groups: [], choice: clientValue({ kind: "specific", ref: { group: "collaboration", name: "send_message" } }), parallel: defaultValue(true) },
    }));
    expect(grouped.body.tool_choice).toEqual({ type: "function", name: "send_message", namespace: "collaboration" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lift：正常流", () => {
  // 帧序取自 PROTOCOL_REFERENCE §11 的真实抓包。
  const frames = [
    { type: "response.created", response: { id: "resp_1", model: "gpt-5.6-sol", status: "in_progress" } },
    { type: "response.in_progress", response: { id: "resp_1" } },
    { type: "keepalive" },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: null } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "thinking hard" },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking hard" }], encrypted_content: "gAAAAABqcDx8" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.content_part.added", output_index: 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Hello" },
    { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: " world" },
    { type: "response.output_text.done", output_index: 1, content_index: 0, text: "Hello world" },
    { type: "response.content_part.done", output_index: 1, content_index: 0, part: { type: "output_text", text: "Hello world" } },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello world" }] } },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_x", name: "exec_command", namespace: "collaboration", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "{\"cmd\":" },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_1", delta: "\"pwd\"}" },
    { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: "{\"cmd\":\"pwd\"}" },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_x", name: "exec_command", namespace: "collaboration", arguments: "{\"cmd\":\"pwd\"}" } },
    { type: "response.completed", response: {
      id: "resp_1", status: "completed", model: "gpt-5.6-sol",
      usage: { input_tokens: 18661, input_tokens_details: { cached_tokens: 17792 }, output_tokens: 159, output_tokens_details: { reasoning_tokens: 57 }, total_tokens: 18820 },
    } },
  ];

  it("文本 delta、工具参数分片、推理摘要与加密思考全部落到 IR 上", async () => {
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse(frames)), "fallback");
    expect(assembled.model).toBe("gpt-5.6-sol");
    expect(assembled.stopReason).toBe("toolUse");
    expect(assembled.error).toBeNull();
    expect(assembled.unhandled).toHaveLength(0);

    expect(assembled.turn.parts.map((part) => part.kind))
      .toEqual(["thinking", "redactedThinking", "text", "toolCall"]);
    const [thinking, redacted, text, call] = assembled.turn.parts;
    expect(thinking?.kind === "thinking" && thinking.text).toBe("thinking hard");
    expect(redacted?.kind === "redactedThinking" && redacted.data).toBe("gAAAAABqcDx8");
    expect(text?.kind === "text" && text.text).toBe("Hello world");
    expect(call?.kind === "toolCall" && call.call.toolRef).toEqual({ group: "collaboration", name: "exec_command" });
    expect(call?.kind === "toolCall" && call.call.input).toEqual({ kind: "json", value: { cmd: "pwd" } });
  });

  it("usage 换算成 Anthropic 语义：input 必须减去 cached_tokens", async () => {
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse(frames)), "fallback");
    // 实测 input_tokens 18661 **含** cached 17792；不减的话缓存被双倍计入输入。
    expect(assembled.usage).toEqual({
      inputTokens: 18661 - 17792,
      outputTokens: 159,
      cacheReadTokens: 17792,
      reasoningTokens: 57,
    });
    // 三态：Responses 不报缓存写入量，保持 undefined（= 上游不支持），不是 0。
    expect(assembled.usage?.cacheWriteTokens).toBeUndefined();
  });

  it("keepalive 不算未识别事件；真正没见过的事件才产 unhandled", async () => {
    const events = await collect(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "keepalive" },
      { type: "response.brand_new_thing", output_index: 0, payload: 1 },
      { type: "response.output_item.added", output_index: 0, item: { type: "image_generation_call", id: "ig_1" } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));
    const unhandled = events.filter((event) => event.kind === "unhandled");
    expect(unhandled.map((event) => event.rawType)).toEqual([
      "response.brand_new_thing",
      "response.output_item.added:image_generation_call",
    ]);
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });
  });

  it("freeform 工具调用走 custom_tool_call，入参保持自由文本", async () => {
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_p", name: "apply_patch", input: "" } },
      { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_1", delta: "*** Begin Patch" },
      { type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch" } },
      { type: "response.completed", response: { status: "completed" } },
    ])), "m");
    const call = assembled.turn.parts[0];
    expect(call?.kind === "toolCall" && call.call.input).toEqual({ kind: "text", text: "*** Begin Patch" });
    expect(assembled.stopReason).toBe("toolUse");
  });

  it("只有 done 带全量参数（没有任何 delta）时补发，不静默丢工具入参", async () => {
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_y", name: "T", arguments: "" } },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: "{\"a\":1}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_y", name: "T", arguments: "{\"a\":1}" } },
      { type: "response.completed", response: { status: "completed" } },
    ])), "m");
    const call = assembled.turn.parts[0];
    expect(call?.kind === "toolCall" && call.call.input).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("incomplete_details.reason = max_output_tokens → maxTokens，不是 endTurn", async () => {
    const events = await collect(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "cut" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]));
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lift：失败形态一个都不能吞", () => {
  it("流截断没有终止事件 → error 而不是「200 但空」的假成功", async () => {
    const events = await collect(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "half a sen" },
    ]));
    const last = events.at(-1);
    expect(last?.kind).toBe("error");
    expect(last?.kind === "error" && last.error.kind).toBe("transport");
    expect(last?.kind === "error" && last.error.retryable).toBe(true);

    // 折叠后 stopReason 仍为 null —— 调用方据此区分「说完了」与「连接断了」。
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse([
      { type: "response.created", response: { model: "m" } },
    ])), "m");
    expect(assembled.stopReason).toBeNull();
    expect(assembled.error?.kind).toBe("transport");
  });

  it("response.failed 里的 context_length_exceeded 必须显形（实测一天 126 次被吞）", async () => {
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "response.failed", response: {
        status: "failed",
        error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." },
        usage: { input_tokens: 300000, output_tokens: 0 },
      } },
    ])), "m");
    expect(assembled.error?.kind).toBe("contextLengthExceeded");
    expect(assembled.error?.retryable).toBe(false);
    expect(assembled.usage?.inputTokens).toBe(300000);
    expect(assembled.stopReason).toBeNull();
  });

  it("顶层 error 事件（另一种失败形态）同样映射到 IRUpstreamError", async () => {
    const events = await collect(sse([
      { type: "response.created", response: { model: "m" } },
      { type: "error", error: { type: "server_error", code: "server_error", message: "upstream blew up" } },
    ]));
    const failure = events.find((event) => event.kind === "error");
    expect(failure?.kind === "error" && failure.error.kind).toBe("upstreamUnavailable");
    expect(failure?.kind === "error" && failure.error.retryable).toBe(true);
    // 已经有终止事件，不能再补一条 transport error。
    expect(events.filter((event) => event.kind === "error")).toHaveLength(1);
  });

  it("data 段解析不出 JSON 时进 unhandled，而不是被丢掉", async () => {
    const body = "event: response.output_text.delta\ndata: {not json\n\n";
    const events = await collect(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(events[0]).toEqual({ kind: "unhandled", rawType: "response.output_text.delta", raw: "{not json" });
    expect(events.at(-1)?.kind).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lift：非流式 JSON 合成等价事件序列", () => {
  it("output item 逐个还原成 part，下游 encode 不需要区分两条路径", async () => {
    const payload = {
      id: "resp_1", object: "response", status: "completed", model: "gpt-5.6-sol",
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "gAAA" },
        { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] },
        { type: "function_call", id: "fc_1", call_id: "call_z", name: "send_message", namespace: "collaboration", arguments: "{\"target\":\"/root\"}" },
        { type: "web_search_call", id: "ws_1", status: "completed" },
      ],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 10 },
    };
    const response = new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    const assembled = await assembleResponse(egress.readUpstreamResponse(response), "fallback");

    expect(assembled.model).toBe("gpt-5.6-sol");
    expect(assembled.turn.parts.map((part) => part.kind)).toEqual(["thinking", "redactedThinking", "text", "toolCall"]);
    const call = assembled.turn.parts[3];
    expect(call?.kind === "toolCall" && call.call.toolRef).toEqual({ group: "collaboration", name: "send_message" });
    expect(call?.kind === "toolCall" && call.call.input).toEqual({ kind: "json", value: { target: "/root" } });
    expect(assembled.stopReason).toBe("toolUse");
    expect(assembled.usage).toEqual({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 40 });
    // 没建模的 item 是流里的元素，不是可以跳过的噪音。
    expect(assembled.unhandled.map((event) => event.rawType)).toEqual(["output_item:web_search_call"]);
  });

  it("非流式的 status:'failed' 走 error，不产出空成功", async () => {
    const response = new Response(JSON.stringify({
      id: "resp_1", object: "response", status: "failed",
      error: { code: "rate_limit_exceeded", message: "Rate limit reached" },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const events = await collect(response);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === "error" && events[0].error.kind).toBe("rateLimited");
    expect(events[0]?.kind === "error" && events[0].error.retryable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("lift：HTTP 层失败映射", () => {
  const cases: ReadonlyArray<{
    readonly status: number;
    readonly payload: unknown;
    readonly kind: string;
    readonly retryable: boolean;
  }> = [
    { status: 400, payload: { error: { type: "invalid_request_error", code: "invalid_request", message: "bad" } }, kind: "invalidRequest", retryable: false },
    { status: 400, payload: { error: { code: "context_length_exceeded", message: "input too long" } }, kind: "contextLengthExceeded", retryable: false },
    { status: 401, payload: { error: { code: "invalid_api_key", message: "no key" } }, kind: "permissionDenied", retryable: false },
    { status: 429, payload: { error: { code: "rate_limit_exceeded", message: "slow down" } }, kind: "rateLimited", retryable: true },
    { status: 429, payload: { error: { type: "insufficient_quota", message: "you ran out" } }, kind: "quotaExhausted", retryable: false },
    { status: 500, payload: { error: { type: "server_error", message: "boom" } }, kind: "upstreamUnavailable", retryable: true },
    { status: 503, payload: "upstream down", kind: "upstreamUnavailable", retryable: true },
  ];

  for (const testCase of cases) {
    it(`${testCase.status} → ${testCase.kind}（retryable=${testCase.retryable}）`, async () => {
      const body = typeof testCase.payload === "string" ? testCase.payload : JSON.stringify(testCase.payload);
      const events = await collect(new Response(body, { status: testCase.status }));
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.kind).toBe("error");
      if (event?.kind !== "error") return;
      expect(event.error.kind).toBe(testCase.kind as typeof event.error.kind);
      expect(event.error.retryable).toBe(testCase.retryable);
      expect(event.error.httpStatus).toBe(testCase.status);
    });
  }
});
