/**
 * 请求 ↔ 响应的对称性。
 *
 * 这组测试锁的是设计而不是实现：IR 必须同时承载「送上去的请求」与「回来的响应」，
 * 且两者讲同一种语言 —— 一轮的响应应当**原样**成为下一轮请求历史里的助手回合，
 * 不必绕一圈 wire 再 decode 回来。缺了这条，多轮 agent 的每一轮都要经历一次有损往返。
 */
import { describe, expect, it } from "bun:test";
import { assembleResponse, asResponsePart } from "../src/ir/response.ts";
import { readAnthropicMessagesRequest } from "../src/inbox/index.ts";
import type { IREvent, IRPart, IRTurn } from "../src/ir/types.ts";

async function* streamOf(events: readonly IREvent[]): AsyncGenerator<IREvent> {
  for (const event of events) yield event;
}

/** 一段典型的助手产出：思考 + 文本 + 两个并行工具调用，全部分片到达。 */
const TYPICAL_STREAM: readonly IREvent[] = [
  { kind: "messageStart", model: "claude-opus-5" },
  { kind: "partStart", index: 0, part: { kind: "thinking", text: "" } },
  { kind: "partDelta", index: 0, delta: { kind: "thinking", text: "让我想想" } },
  { kind: "partDelta", index: 0, delta: { kind: "thinking", text: "……好了" } },
  { kind: "partDelta", index: 0, delta: { kind: "thinkingSignature", signature: "sig-abc" } },
  { kind: "partEnd", index: 0 },
  { kind: "partStart", index: 1, part: { kind: "text", text: "" } },
  { kind: "partDelta", index: 1, delta: { kind: "text", text: "我去读两个文件。" } },
  { kind: "partEnd", index: 1 },
  { kind: "partStart", index: 2, part: { kind: "toolCall", call: { id: "t1", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: {} } } } },
  { kind: "partDelta", index: 2, delta: { kind: "toolInputJson", json: '{"path":' } },
  { kind: "partDelta", index: 2, delta: { kind: "toolInputJson", json: '"a.txt"}' } },
  { kind: "partEnd", index: 2 },
  { kind: "partStart", index: 3, part: { kind: "toolCall", call: { id: "t2", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: {} } } } },
  { kind: "partDelta", index: 3, delta: { kind: "toolInputJson", json: '{"path":"b.txt"}' } },
  { kind: "partEnd", index: 3 },
  { kind: "usage", usage: { inputTokens: 10, outputTokens: 42, cacheReadTokens: 0 } },
  { kind: "messageStop", reason: "toolUse" },
];

describe("响应文档形态", () => {
  it("把分片事件流折叠成完整的助手回合", async () => {
    const assembled = await assembleResponse(streamOf(TYPICAL_STREAM), "fallback");
    expect(assembled.model).toBe("claude-opus-5");
    expect(assembled.stopReason).toBe("toolUse");
    expect(assembled.usage).toEqual({ inputTokens: 10, outputTokens: 42, cacheReadTokens: 0 });
    expect(assembled.error).toBeNull();
    expect(assembled.turn.role).toBe("assistant");
    expect(assembled.turn.parts).toEqual([
      { kind: "thinking", text: "让我想想……好了", signature: "sig-abc" },
      { kind: "text", text: "我去读两个文件。" },
      { kind: "toolCall", call: { id: "t1", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: { path: "a.txt" } } } },
      { kind: "toolCall", call: { id: "t2", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: { path: "b.txt" } } } },
    ]);
  });

  it.each([
    {
      input: '{"broken',
      detail: "tool input JSON could not be parsed; preserved raw fragments as freeform text",
    },
    {
      input: "[]",
      detail: "tool input JSON parsed to a non-object; preserved raw fragments as freeform text",
    },
  ])("分片 JSON 无法成为对象时降级成 freeform 原文并记录 loss", async ({ input, detail }) => {
    const assembled = await assembleResponse(streamOf([
      { kind: "partStart", index: 0, part: { kind: "toolCall", call: { id: "t", toolRef: { group: null, name: "X" }, input: { kind: "json", value: {} } } } },
      { kind: "partDelta", index: 0, delta: { kind: "toolInputJson", json: input } },
      { kind: "partEnd", index: 0 },
      { kind: "messageStop", reason: "toolUse" },
    ]), "m");
    const part = assembled.turn.parts[0];
    expect(part?.kind === "toolCall" && part.call.input).toEqual({ kind: "text", text: input });
    expect(assembled.losses).toContainEqual({
      stage: "outbox", outbox: null, path: "$.response.parts[0].call.input", kind: "degraded", detail,
    });
  });

  it("上游没发终止事件时 stopReason 为 null —— 用来区分「说完了」与「断了」", async () => {
    const assembled = await assembleResponse(streamOf([
      { kind: "messageStart", model: "m" },
      { kind: "partStart", index: 0, part: { kind: "text", text: "半句" } },
    ]), "m");
    expect(assembled.stopReason).toBeNull();
    expect(assembled.error).toBeNull();
  });

  it("上游错误是数据不是异常：折叠照常返回，靠 error 判结局", async () => {
    const assembled = await assembleResponse(streamOf([
      { kind: "error", error: { kind: "contextLengthExceeded", httpStatus: 400, message: "too long", retryable: false, raw: null } },
    ]), "m");
    expect(assembled.error?.kind).toBe("contextLengthExceeded");
    expect(assembled.turn.parts).toEqual([]);
  });

  it("未识别事件与错序 delta 都进 unhandled，不静默丢内容", async () => {
    const assembled = await assembleResponse(streamOf([
      { kind: "unhandled", rawType: "response.brand_new", raw: { a: 1 } },
      { kind: "partDelta", index: 7, delta: { kind: "text", text: "orphan" } },
      { kind: "messageStop", reason: "endTurn" },
    ]), "m");
    expect(assembled.unhandled.map((entry) => entry.rawType))
      .toEqual(["response.brand_new", "partDelta-without-partStart"]);
  });

  it("非模型产出形态出现在响应里会被丢弃并留痕（响应读取映射错了的信号）", async () => {
    const assembled = await assembleResponse(streamOf([
      { kind: "partStart", index: 0, part: { kind: "image", media: { source: { kind: "base64", data: "AAA" }, mediaType: "image/png" } } },
      { kind: "messageStop", reason: "endTurn" },
    ]), "m");
    expect(assembled.turn.parts).toEqual([]);
    expect(assembled.losses[0]).toMatchObject({ stage: "outbox", kind: "dropped", path: "$.response.parts[0]" });
  });
});

describe("闭环：响应回合直接接回下一轮请求", () => {
  it("组装出的助手回合就是 IRTurn，可以原样进 conversation.turns", async () => {
    const assembled = await assembleResponse(streamOf(TYPICAL_STREAM), "m");

    // 类型上成立：IRTurn<IRResponsePart> 对 part 协变，因此**是**一个 IRTurn。
    const asHistory: IRTurn = assembled.turn;
    expect(asHistory.role).toBe("assistant");

    // 语义上成立：把它接到下一轮，工具调用 id 仍然是关联锚点。
    const nextTurns: IRTurn[] = [
      { role: "user", parts: [{ kind: "text", text: "读一下" }] },
      asHistory,
      { role: "user", parts: [
        { kind: "toolResult", result: { callId: "t1", parts: [{ kind: "text", text: "A" }], status: "ok" } },
        { kind: "toolResult", result: { callId: "t2", parts: [{ kind: "text", text: "B" }], status: "ok" } },
      ] },
    ];
    const declared = new Set<string>();
    for (const turn of nextTurns) {
      for (const part of turn.parts) if (part.kind === "toolCall") declared.add(part.call.id);
    }
    for (const turn of nextTurns) {
      for (const part of turn.parts) {
        if (part.kind === "toolResult") expect(declared.has(part.result.callId)).toBe(true);
      }
    }
  });

  it("与从 wire 重新 decode 出来的历史等价 —— 绕 wire 一圈不会改变语义", async () => {
    const assembled = await assembleResponse(streamOf(TYPICAL_STREAM), "m");

    // 同一段助手产出，改从 Anthropic wire 走一遍 decode。
    const viaWire = readAnthropicMessagesRequest({
      model: "m", max_tokens: 8,
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我想想……好了", signature: "sig-abc" },
          { type: "text", text: "我去读两个文件。" },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "b.txt" } },
        ],
      }],
    }, "tr").request.conversation.turns[0];

    expect(viaWire?.parts).toEqual(assembled.turn.parts as readonly IRPart[]);
  });
});

describe("asResponsePart 收窄", () => {
  it("模型产出形态通过，客户端上送形态拦下", () => {
    const outputs: IRPart[] = [
      { kind: "text", text: "t" },
      { kind: "thinking", text: "k" },
      { kind: "redactedThinking", data: "d" },
      { kind: "toolCall", call: { id: "i", toolRef: { group: null, name: "n" }, input: { kind: "json", value: {} } } },
    ];
    const inputsOnly: IRPart[] = [
      { kind: "image", media: { source: { kind: "base64", data: "A" }, mediaType: "image/png" } },
      { kind: "document", media: { source: { kind: "url", url: "u" }, mediaType: "application/pdf" } },
      { kind: "toolResult", result: { callId: "c", parts: [], status: "ok" } },
      { kind: "opaque", origin: "anthropic_messages", tag: "x", raw: null },
    ];
    for (const part of outputs) expect(asResponsePart(part)).toBe(part as never);
    for (const part of inputsOnly) expect(asResponsePart(part)).toBeNull();
  });
});
