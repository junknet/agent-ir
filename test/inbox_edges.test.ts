/**
 * 三个入口的边界与异常用例。
 *
 * 每一条都对应语料里实际出现过的形态，或 agent-all-sdk-ts / cc_proxy 上真实炸过的故障，
 * 注释里标了出处。不写「理论上可能」的臆想用例。
 */
import { describe, expect, it } from "bun:test";
import {
  readAnthropicMessagesRequest, readChatCompletionsRequest, readResponsesRequest,
} from "../src/inbox/index.ts";
import type { IRPart, IRRequest } from "../src/ir/types.ts";

const TRACE = "tr-test";

function partsOfTurn(request: IRRequest, index: number): readonly IRPart[] {
  const turn = request.conversation.turns[index];
  if (turn === undefined) throw new Error(`no turn at index ${index}`);
  return turn.parts;
}

function capabilities(request: IRRequest): string[] {
  return request.requires.map((need) => need.capability).sort();
}

// ═══════════════════════════════════════════════════════════════════════════
describe("anthropic messages inbox", () => {
  it("归位 messages 里的 role:'system'（语料 1537 次）到 conversation.system", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      system: "top-level",
      messages: [
        { role: "system", content: "inline system" },
        { role: "user", content: "hi" },
      ],
    }, TRACE);
    expect(request.conversation.system.map((p) => (p.kind === "text" ? p.text : p.kind)))
      .toEqual(["top-level", "inline system"]);
    // system 不再是一个回合
    expect(request.conversation.turns).toHaveLength(1);
    expect(request.conversation.turns[0]?.role).toBe("user");
  });

  it("system 的 string 形态（语料 148 次）与 array 形态（420 次）产出同一种 IR", () => {
    const fromString = readAnthropicMessagesRequest(
      { model: "m", max_tokens: 8, system: "abc", messages: [{ role: "user", content: "x" }] }, TRACE);
    const fromArray = readAnthropicMessagesRequest(
      { model: "m", max_tokens: 8, system: [{ type: "text", text: "abc" }], messages: [{ role: "user", content: "x" }] }, TRACE);
    expect(fromString.request.conversation.system).toEqual(fromArray.request.conversation.system);
  });

  it("一条 assistant 消息里的并行 tool_use 全部保留（语料最多 9 个）", () => {
    const uses = Array.from({ length: 9 }, (_, i) => ({
      type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `echo ${i}` },
    }));
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "ok" }, ...uses] },
      ],
    }, TRACE);
    const parts = partsOfTurn(request, 1);
    expect(parts.filter((p) => p.kind === "toolCall")).toHaveLength(9);
    expect(parts[0]?.kind).toBe("thinking");
    expect(parts[1]?.kind).toBe("text");
  });

  it("tool_result 的三种 content 形态：string / 数组 / 含图片（语料 13530 / 625 / 94）", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "a", name: "T", input: {} },
          { type: "tool_use", id: "b", name: "T", input: {} },
          { type: "tool_use", id: "c", name: "T", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "a", content: "plain" },
          { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "structured" }] },
          { type: "tool_result", tool_use_id: "c", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ] },
        ] },
      ],
    }, TRACE);
    const results = partsOfTurn(request, 1).filter((p) => p.kind === "toolResult");
    expect(results).toHaveLength(3);
    expect(results[0]?.kind === "toolResult" && results[0].result.parts[0]?.kind).toBe("text");
    expect(results[2]?.kind === "toolResult" && results[2].result.parts[0]?.kind).toBe("image");
    expect(capabilities(request)).toContain("toolResultImage");
  });

  it("is_error=true（语料 709 次）落成 status='error'，是一等状态不是异常", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "T", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "boom", is_error: true }] },
      ],
    }, TRACE);
    const part = partsOfTurn(request, 1)[0];
    expect(part?.kind === "toolResult" && part.result.status).toBe("error");
    expect(capabilities(request)).toContain("toolResultError");
  });

  it("type:'custom' 的工具带 input_schema 时保留 schema —— 当 freeform 会丢掉整个参数契约", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      tools: [
        { type: "custom", name: "bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { type: "custom", name: "freeform_only", description: "no schema" },
      ],
    }, TRACE);
    const [withSchema, withoutSchema] = request.conversation.toolset.tools;
    expect(withSchema?.kind).toBe("function");
    expect(withSchema?.kind === "function" && withSchema.schema).toEqual({ type: "object", properties: { command: { type: "string" } } });
    expect(withoutSchema?.kind).toBe("freeform");
  });

  it("computer_20251124 这类内建工具落成 builtin 并保留配置", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      tools: [{ type: "computer_20251124", name: "computer", display_width_px: 1280, display_height_px: 720, display_number: 1 }],
    }, TRACE);
    const tool = request.conversation.toolset.tools[0];
    expect(tool?.kind).toBe("builtin");
    expect(tool?.kind === "builtin" && tool.config?.display_width_px).toBe(1280);
  });

  it("tool_use.caller 是对象 {type:'direct'}，按字符串读会整个丢掉", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: {}, caller: { type: "direct" } }] }],
    }, TRACE);
    const part = partsOfTurn(request, 0)[0];
    expect(part?.kind === "toolCall" && part.call.caller?.kind).toBe("direct");
  });

  it("thinking adaptive + output_config.effort 共存时两个维度都留下（正交，不是互斥）", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    }, TRACE);
    const reasoning = request.intent.reasoning.value;
    expect(reasoning.mode).toBe("adaptive");
    expect(reasoning.effort).toBe("high");
    expect(reasoning.display).toBe("summarized");
    expect(capabilities(request)).toContain("reasoningEffort");
  });

  it("output_config.format 的 json_schema 落成结构化输出需求", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
    }, TRACE);
    expect(request.intent.outputFormat.value.kind).toBe("jsonSchema");
    expect(capabilities(request)).toContain("structuredOutput");
  });

  it("context_management.edits 保留原始指令供能表达它的出口还原", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    }, TRACE);
    expect(request.intent.contextEdits).toHaveLength(1);
    expect(request.intent.contextEdits[0]?.kind).toBe("clearThinking");
    expect(request.intent.contextEdits[0]?.raw).toEqual({ type: "clear_thinking_20251015", keep: "all" });
    expect(capabilities(request)).toContain("contextEdit");
  });

  it("cache_control 在五个位置都识别成 part 级断点", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "T", input: {}, cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    }, TRACE);
    expect(request.conversation.system[0]?.cacheBreakpoint?.scope).toBe("ephemeral");
    expect(partsOfTurn(request, 0)[0]?.cacheBreakpoint).toBeDefined();
    expect(partsOfTurn(request, 1)[0]?.cacheBreakpoint).toBeDefined();
    expect(partsOfTurn(request, 2)[0]?.cacheBreakpoint?.ttlSeconds).toBe(3600);
  });

  it("metadata.user_id 里的 JSON 会话身份被解析出来（Claude Code 形态）", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      metadata: { user_id: JSON.stringify({ device_id: "d1", account_uuid: "", session_id: "s1" }) },
    }, TRACE);
    expect(request.intent.identity).toEqual({ sessionId: "s1", deviceId: "d1" });
  });

  it("metadata.user_id 不是 JSON 时不报错，只是没有身份", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }],
      metadata: { user_id: "plain-user" },
    }, TRACE);
    expect(request.intent.identity).toEqual({});
  });

  it("不认识的内容块装箱成 opaque 而不是丢掉，并记一条 degraded", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: [{ type: "future_block_2027", payload: 42 }] }],
    }, TRACE);
    const part = partsOfTurn(request, 0)[0];
    expect(part?.kind).toBe("opaque");
    expect(part?.kind === "opaque" && part.tag).toBe("future_block_2027");
    expect(losses.some((l) => l.kind === "degraded")).toBe(true);
  });

  it("相邻同角色的空回合被合并吸收，**不**记 loss —— 它确实什么都没丢", () => {
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{ role: "user", content: "" }, { role: "user", content: "real" }],
    }, TRACE);
    expect(request.conversation.turns).toHaveLength(1);
    expect(partsOfTurn(request, 0)).toEqual([{ kind: "text", text: "real" }]);
    expect(losses).toEqual([]);
  });

  it("孤立的空回合**原样保留**，Core 不丢也不留痕 —— 丢空是策略", () => {
    // 这条原本断言「丢掉并留痕」，锁的正是被剥离出去的 dropEmptyTurns。
    // 丢空回合是「我替你删」，已归 repair 层的 dropEmptyTurn；Core 只做确定性编译，
    // 把空回合原样交给 outbox，由各 wire 按自己的编译事实处置。
    const { request, losses } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "" },
        { role: "user", content: "second" },
      ],
    }, TRACE);
    expect(request.conversation.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(partsOfTurn(request, 1)).toEqual([]);
    expect(losses).toEqual([]);
  });

  it("非对象 body 直接抛，不产出半个 IR", () => {
    expect(() => readAnthropicMessagesRequest("not-json-object", TRACE)).toThrow(TypeError);
    expect(() => readAnthropicMessagesRequest([1, 2, 3], TRACE)).toThrow(TypeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("openai chat completions inbox", () => {
  it("role:'tool' 归位成 user 回合里的 toolResult，连续多条合并成一个回合", () => {
    // 这正是 agent-all-sdk-ts 上炸过的形态：并行工具调用 → 连续多条 role:'tool' →
    // 不合并就变成多条 user 消息 → 转回 Anthropic 被判「漏了结果」，补占位后与真结果撞成 400。
    const { request } = readChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } },
          { id: "c2", type: "function", function: { name: "f", arguments: "{\"a\":2}" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "r1" },
        { role: "tool", tool_call_id: "c2", content: "r2" },
      ],
    }, TRACE);
    expect(request.conversation.turns).toHaveLength(3);
    const results = partsOfTurn(request, 2);
    expect(results).toHaveLength(2);
    expect(results.every((p) => p.kind === "toolResult")).toBe(true);
  });

  it("tool_calls 的 arguments 不是合法 JSON 时降级成 freeform 文本入参并留痕", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m",
      messages: [{ role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "f", arguments: "{broken" } },
      ] }],
    }, TRACE);
    const part = partsOfTurn(request, 0)[0];
    expect(part?.kind === "toolCall" && part.call.input.kind).toBe("text");
    expect(part?.kind === "toolCall" && part.call.input.kind === "text" && part.call.input.text).toBe("{broken");
    expect(losses.some((l) => l.kind === "degraded")).toBe(true);
  });

  it("没有 tool_call_id 的 tool 消息无法关联，丢弃并留痕（不静默变成普通文本）", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }, { role: "tool", content: "orphan" }],
    }, TRACE);
    expect(request.conversation.turns).toHaveLength(1);
    expect(losses.some((l) => l.detail.includes("tool_call_id"))).toBe(true);
  });

  it("developer 与 system 两种角色都归位到 conversation.system", () => {
    const { request } = readChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "system", content: "s1" },
        { role: "developer", content: "s2" },
        { role: "user", content: "u" },
      ],
    }, TRACE);
    expect(request.conversation.system).toHaveLength(2);
    expect(request.conversation.turns).toHaveLength(1);
  });

  it("image_url 的嵌套 data URL 解析成 base64 blob", () => {
    const { request } = readChatCompletionsRequest({
      model: "m",
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
      ] }],
    }, TRACE);
    const image = partsOfTurn(request, 0)[1];
    expect(image?.kind).toBe("image");
    expect(image?.kind === "image" && image.media.source.kind).toBe("base64");
    expect(image?.kind === "image" && image.media.mediaType).toBe("image/jpeg");
  });

  it("三个 token 上限键任取其一，语义相同不重复", () => {
    for (const key of ["max_completion_tokens", "max_tokens", "max_output_tokens"]) {
      const { request } = readChatCompletionsRequest(
        { model: "m", messages: [{ role: "user", content: "x" }], [key]: 512 }, TRACE);
      expect(request.intent.stopping.maxOutputTokens?.value).toBe(512);
    }
  });

  it("response_format json_object 没有 schema，降级成 text 并留痕，不假装等价", () => {
    const { request, losses } = readChatCompletionsRequest({
      model: "m", messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_object" },
    }, TRACE);
    expect(request.intent.outputFormat.value.kind).toBe("text");
    expect(losses.some((l) => l.path === "$.response_format")).toBe(true);
  });

  it("reasoning_effort 落成 effort 且 source=client；缺省时是 gateway-default", () => {
    const explicit = readChatCompletionsRequest(
      { model: "m", messages: [{ role: "user", content: "x" }], reasoning_effort: "high" }, TRACE);
    expect(explicit.request.intent.reasoning.source).toBe("client");
    expect(explicit.request.intent.reasoning.value.effort).toBe("high");

    const implicit = readChatCompletionsRequest(
      { model: "m", messages: [{ role: "user", content: "x" }] }, TRACE);
    expect(implicit.request.intent.reasoning.source).toBe("gateway-default");
    expect(implicit.request.intent.reasoning.value.effort).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("openai responses inbox", () => {
  it("instructions 与 developer 消息都是系统提示载体", () => {
    const { request } = readResponsesRequest({
      model: "m", instructions: "top",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "u" }] },
      ],
    }, TRACE);
    expect(request.conversation.system.map((p) => (p.kind === "text" ? p.text : p.kind))).toEqual(["top", "dev"]);
    expect(request.conversation.turns).toHaveLength(1);
  });

  it("function_call 的 namespace 是结构化分组，不做名字拍平", () => {
    const { request } = readResponsesRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "close_agent", namespace: "multi_agent_v1", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    }, TRACE);
    const call = partsOfTurn(request, 0)[0];
    expect(call?.kind === "toolCall" && call.call.toolRef).toEqual({ group: "multi_agent_v1", name: "close_agent" });
    expect(capabilities(request)).toContain("toolGroup");
  });

  it("custom_tool_call 的 input 是自由文本，保持 freeform 不硬塞成 JSON", () => {
    const { request } = readResponsesRequest({
      model: "m",
      input: [{ type: "custom_tool_call", call_id: "c1", name: "exec", input: "const r = await tools.exec()" }],
    }, TRACE);
    const call = partsOfTurn(request, 0)[0];
    expect(call?.kind === "toolCall" && call.call.input.kind).toBe("text");
    expect(capabilities(request)).toContain("toolFreeform");
  });

  it("custom_tool_call 的 status='failed' 落成结果 error 态", () => {
    const { request } = readResponsesRequest({
      model: "m",
      input: [
        { type: "custom_tool_call", call_id: "c1", name: "exec", input: "x" },
        { type: "custom_tool_call_output", call_id: "c1", output: "boom", status: "failed" },
      ],
    }, TRACE);
    const result = partsOfTurn(request, 1)[0];
    expect(result?.kind === "toolResult" && result.result.status).toBe("error");
  });

  it("reasoning item 的 summary 与 encrypted_content 分别落成 thinking / redactedThinking", () => {
    const { request } = readResponsesRequest({
      model: "m",
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "ENC" }],
    }, TRACE);
    const parts = partsOfTurn(request, 0);
    expect(parts.map((p) => p.kind)).toEqual(["thinking", "redactedThinking"]);
  });

  it("namespace 工具展开成带 group 的成员 + 一条分组记录", () => {
    const { request } = readResponsesRequest({
      model: "m", input: [{ type: "message", role: "user", content: "x" }],
      tools: [{ type: "namespace", name: "multi_agent_v1", description: "d", tools: [
        { type: "function", name: "close_agent", description: "c", parameters: { type: "object" } },
        { type: "function", name: "spawn_agent", description: "s", parameters: { type: "object" } },
      ] }],
    }, TRACE);
    expect(request.conversation.toolset.tools).toHaveLength(2);
    expect(request.conversation.toolset.tools.every((t) => t.ref.group === "multi_agent_v1")).toBe(true);
    expect(request.conversation.toolset.groups).toEqual([{ name: "multi_agent_v1", members: ["close_agent", "spawn_agent"] }]);
  });

  it("没有 name 的内建工具（web_search）以 type 兜底，不因缺名被整条丢掉", () => {
    const { request } = readResponsesRequest({
      model: "m", input: [{ type: "message", role: "user", content: "x" }],
      tools: [{ type: "web_search", external_web_access: false }],
    }, TRACE);
    const tool = request.conversation.toolset.tools[0];
    expect(tool?.kind).toBe("builtin");
    expect(tool?.ref.name).toBe("web_search");
    expect(tool?.kind === "builtin" && tool.config?.external_web_access).toBe(false);
  });

  it("input_image 的 image_url 是裸字符串（不是 Chat 的嵌套对象）", () => {
    const { request } = readResponsesRequest({
      model: "m",
      input: [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" },
      ] }],
    }, TRACE);
    const image = partsOfTurn(request, 0)[0];
    expect(image?.kind).toBe("image");
    expect(image?.kind === "image" && image.media.mediaType).toBe("image/jpeg");
  });

  it("input 是裸字符串时当作单条 user 消息", () => {
    const { request } = readResponsesRequest({ model: "m", input: "just text" }, TRACE);
    expect(request.conversation.turns).toHaveLength(1);
    expect(partsOfTurn(request, 0)[0]).toEqual({ kind: "text", text: "just text" });
  });

  it("未知 item 类型装箱成 opaque 并留痕", () => {
    const { request, losses } = readResponsesRequest({
      model: "m", input: [{ type: "web_search_call", id: "ws_1", status: "completed" }],
    }, TRACE);
    expect(partsOfTurn(request, 0)[0]?.kind).toBe("opaque");
    expect(losses.some((l) => l.detail.includes("web_search_call"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("cross-protocol invariants", () => {
  it("三个协议表达同一段对话时，产出结构等价的 IR", () => {
    const anthropic = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8, system: "sys",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "r" }] },
      ],
    }, TRACE).request;

    const chat = readChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    }, TRACE).request;

    const responses = readResponsesRequest({
      model: "m", instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{\"a\":1}" },
        { type: "function_call_output", call_id: "c1", output: "r" },
      ],
    }, TRACE).request;

    for (const request of [anthropic, chat, responses]) {
      expect(request.conversation.system).toEqual([{ kind: "text", text: "sys" }]);
      expect(request.conversation.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
      expect(partsOfTurn(request, 1)[0]).toEqual({
        kind: "toolCall",
        call: { id: "c1", toolRef: { group: null, name: "f" }, input: { kind: "json", value: { a: 1 } } },
      });
      expect(partsOfTurn(request, 2)[0]).toEqual({
        kind: "toolResult",
        result: { callId: "c1", parts: [{ kind: "text", text: "r" }], status: "ok" },
      });
    }
  });

  it("关联靠 id 而非位置：把工具结果放到后面的回合，IR 依然关联得上", () => {
    const { request } = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "text", text: "unrelated" }] },
        { role: "assistant", content: [{ type: "text", text: "still going" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "late" }] },
      ],
    }, TRACE);
    const result = partsOfTurn(request, 3)[0];
    // 位置隔了两个回合，关联仍然成立 —— Anthropic wire 的「必须紧邻」是 outbox 的事。
    expect(result?.kind === "toolResult" && result.result.callId).toBe("c1");
  });
});
