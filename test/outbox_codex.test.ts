/** 由 codex_20260805T021301Z-3991747.mitm 提炼的脱敏 Codex 私有 wire 契约。 */
import { describe, expect, it } from "bun:test";
import {
  createCodexWebSocketResponseOutbox,
  createCodexAlphaSearchToolResult,
  createCodexAlphaSearchWireRequest,
  executeCodexAlphaSearch,
  readCodexAlphaSearchResults,
} from "../src/outbox/codex/index.ts";
import { defaultValue, type IRIntent, type IRRequest, type IRToolset, type IRTurn } from "../src/ir/types.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";

const emptyToolset: IRToolset = {
  tools: [], groups: [], choice: defaultValue({ kind: "auto" }), parallel: defaultValue(true),
};

function makeRequest(input: {
  readonly turns: readonly IRTurn[];
  readonly toolset?: IRToolset;
  readonly intent?: Partial<IRIntent>;
}): IRRequest {
  const intent: IRIntent = {
    reasoning: defaultValue({ mode: "auto", display: "summarized" }),
    outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"),
    sampling: {}, stopping: {}, contextEdits: [], stream: defaultValue(true),
    identity: { sessionId: "session-test" }, ...input.intent,
  };
  const partial = {
    traceId: "codex-contract", protocol: "openai_responses" as const, model: "client-model",
    conversation: { system: [], turns: input.turns, toolset: input.toolset ?? emptyToolset }, intent,
  };
  return { ...partial, requires: deriveCapabilityNeeds(partial) };
}

const outbox = createCodexWebSocketResponseOutbox({
  model: "gpt-5-codex",
  webSocketHeaders: { authorization: "Bearer redacted", "chatgpt-account-id": "redacted" },
  clientMetadata: {
    installationId: "install-test", turnId: "turn-test", sessionId: "session-test", threadId: "thread-test",
    turnMetadata: "{}", windowId: "window-test", responsesLite: "true", streamRequestStartedAtMilliseconds: "0",
  },
});

async function collectEvents(frames: readonly string[]) {
  const source = (async function* (): AsyncGenerator<string> { yield* frames; })();
  const events = [];
  for await (const event of outbox.readCodexWebSocketResponseEvents("session-test", source)) events.push(event);
  return events;
}

describe("Codex WebSocket response.create", () => {
  it("首帧把图片与工具定义放入实测的 input/additional_tools 结构", async () => {
    const built = await outbox.writeCodexWebSocketResponseCreate(makeRequest({
      turns: [{ role: "user", parts: [
        { kind: "text", text: "describe this image" },
        { kind: "image", media: { source: { kind: "base64", data: "AAE=" }, mediaType: "image/png" } },
      ] }],
      toolset: {
        tools: [{ kind: "freeform", ref: { group: null, name: "exec" }, description: "Run a command." }],
        groups: [], choice: defaultValue({ kind: "auto" }), parallel: defaultValue(true),
      },
    }));
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    const payload = JSON.parse(built.frame.payload) as Record<string, unknown>;
    const input = payload.input as Array<Record<string, unknown>>;
    expect(payload.type).toBe("response.create");
    expect(built.frame.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(input[0]).toEqual({ type: "additional_tools", role: "developer", tools: [
      { type: "custom", name: "exec", description: "Run a command." },
    ] });
    const message = input[1] as Record<string, unknown>;
    expect((message.content as Array<Record<string, unknown>>)[1]).toEqual({
      type: "input_image", image_url: "data:image/png;base64,AAE=",
    });
    expect(payload.previous_response_id).toBeUndefined();
  });

  it("读取 response.created 后，续轮只回送三个 custom_tool_call_output 并带 previous_response_id", async () => {
    const events = await collectEvents([
      JSON.stringify({ type: "response.created", response: { id: "resp-private-1", model: "gpt-5-codex" } }),
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "tool-item", call_id: "call-1", name: "exec", input: "" } }),
      JSON.stringify({ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "tool-item", delta: "pwd" }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", id: "tool-item", call_id: "call-1", name: "exec", input: "pwd" } }),
      JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
    ]);
    expect(events.some((event) => event.kind === "partStart" && event.part.kind === "toolCall")).toBe(true);

    const built = await outbox.writeCodexWebSocketResponseCreate(makeRequest({
      turns: [
        { role: "assistant", parts: ["a", "b", "c"].map((id) => ({
          kind: "toolCall" as const,
          call: { id: `call-${id}`, toolRef: { group: null, name: "exec" }, input: { kind: "text" as const, text: "pwd" } },
        })) },
        { role: "user", parts: ["a", "b", "c"].map((id) => ({
          kind: "toolResult" as const,
          result: { callId: `call-${id}`, status: "ok" as const, parts: [{ kind: "text" as const, text: id }] },
        })) },
      ],
      toolset: {
        tools: [{ kind: "freeform", ref: { group: null, name: "exec" }, description: "Run a command." }],
        groups: [], choice: defaultValue({ kind: "auto" }), parallel: defaultValue(true),
      },
    }));
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    const payload = JSON.parse(built.frame.payload) as Record<string, unknown>;
    expect(payload.previous_response_id).toBe("resp-private-1");
    expect((payload.input as Array<Record<string, unknown>>).map((item) => item.type)).toEqual([
      "custom_tool_call_output", "custom_tool_call_output", "custom_tool_call_output",
    ]);
  });

  it("格式化为多行的 WebSocket JSON 仍作为一整个 SSE data 事件读取", async () => {
    const events = await collectEvents([
      JSON.stringify({ type: "response.created", response: { id: "resp-multiline", model: "gpt-5-codex" } }, null, 2),
      JSON.stringify({ type: "response.completed", response: { status: "completed" } }, null, 2),
    ]);
    expect(events.some((event) => event.kind === "messageStart")).toBe(true);
    expect(events.some((event) => event.kind === "messageStop")).toBe(true);
  });
});

describe("Codex alpha/search", () => {
  const input = {
    id: "search-test", model: "gpt-5-codex", maxOutputTokens: 256,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "search" }] }],
    query: { query: "agent ir" },
  } as const;

  it("编译实测的 commands.search_query 与 direct caller，不伪装为 Responses tools", () => {
    const wire = createCodexAlphaSearchWireRequest(input, { headers: { authorization: "Bearer redacted" } });
    const body = JSON.parse(wire.body) as Record<string, unknown>;
    expect(wire.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(body.commands).toEqual({ search_query: [{ q: "agent ir" }], response_length: "medium" });
    expect(body.settings).toEqual({ allowed_callers: ["direct"], external_web_access: false });
    expect(body.tools).toBeUndefined();
  });

  it("提升 15 个实测 text_result 字段，并用显式 callId 回灌 IR 工具结果", async () => {
    const results = Array.from({ length: 15 }, (_, index) => ({
      type: "text_result", ref_id: `ref-${index}`, domain: "example.test", snippet: `snippet-${index}`,
      title: `title-${index}`, url: `https://example.test/${index}`,
    }));
    expect(readCodexAlphaSearchResults({ encrypted_output: "not-a-tool-result", output: "not-a-tool-result", results })).toHaveLength(15);
    const result = createCodexAlphaSearchToolResult("call-search", readCodexAlphaSearchResults({ results }));
    expect(result.callId).toBe("call-search");
    expect(result.parts[0]).toEqual(expect.objectContaining({ kind: "text" }));

    const executed = await executeCodexAlphaSearch(input, { headers: {} }, async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    expect(executed).toHaveLength(15);
  });
});
