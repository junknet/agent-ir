/**
 * 流故障矩阵 —— 五个出口 × 十种故障，同一套断言。
 *
 * **红线**（每个出口逐条断言）：任何故障路径都不许产出「200 但空」的假成功。
 * 形式化成一条可机检的性质：
 *
 *     assembleResponse 折出的回合没有任何 part  ⇒  error !== null
 *
 * 这条比「有没有报错」更严：上游掐断时若还照发 messageStop，调用方拿到的是一个
 * stop_reason 正常的空回合，与「模型没话说」不可区分，只能盲重试到 retry cap
 * （生产实测一天 126 次 context_length_exceeded 就是这么消失的）。
 *
 * 为什么把五个出口塞进一张表而不是各写一遍：故障形态是**协议无关**的（帧被切开、
 * 帧解不开、终止事件没来），只有它们的字节表示是协议相关的。表驱动之后，
 * 新增一个出口只需要在 OUTBOX_FIXTURES 里加一行，十条故障自动全覆盖 —— 漏测一种
 * 不再取决于谁记得。
 */
import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { createAnthropicOutbox } from "../src/egress/anthropic.ts";
import { createOpenAIChatOutbox } from "../src/egress/openai_chat_completions.ts";
import { createOpenAIResponsesOutbox } from "../src/egress/openai_responses.ts";
import { createGeminiCloudCodeOutbox, clearThoughtSignatureCache } from "../src/egress/gemini_cloudcode.ts";
import { createWindsurfOutbox } from "../src/egress/windsurf/index.ts";
import { CONNECT_FRAME_HEADER_BYTES, enframe } from "../src/egress/windsurf/connect_frame.ts";
import { getSharedWindsurfSchema } from "../src/egress/windsurf/schema.ts";
import { assembleResponse } from "../src/ir/response.ts";
import { superviseUpstreamStream } from "../src/ir/stream_guard.ts";
import type { IROutbox, IREvent, IRWireBody } from "../src/ir/types.ts";

// ── 字节工具 ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** 把字节按固定粒度切成多个 chunk 下发，用来逼出跨 chunk 的半帧。 */
function streamed(payload: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        controller.enqueue(payload.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

/**
 * 传输层故障：可选地先**送达**一段合法字节，然后连接被 reset。
 *
 * 「送达」是这个夹具的全部难点。`controller.error()` 按 WHATWG 规范会 **ResetQueue** ——
 * 同一个 `start` 里刚 enqueue 的 chunk 连同队列一起被丢掉，读端一个字节都收不到，
 * 直接拿到异常。那模拟的是「连接在任何字节落地前就断」，不是「发了一半才断」，
 * 用它去断言「提交之后断连」永远测不到提交点。
 *
 * 所以分两拍：`start` 里 enqueue，`pull`（消费者已经取走那一块之后才会被调用）里 error。
 * 这才是 ECONNRESET 的真实形状 —— 前半段字节已经在下游手里了。
 */
function severed(prefix: Uint8Array | null): ReadableStream<Uint8Array> {
  let delivered = prefix === null || prefix.length === 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix !== null && prefix.length > 0) controller.enqueue(prefix);
    },
    pull(controller) {
      if (!delivered) { delivered = true; return; }
      controller.error(new Error("ECONNRESET"));
    },
  });
}

async function collect(events: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function kinds(events: readonly IREvent[]): string[] {
  return events.map((event) => event.kind);
}

function textOf(events: readonly IREvent[]): string {
  return events
    .filter((event): event is Extract<IREvent, { kind: "partDelta" }> => event.kind === "partDelta")
    .map((event) => (event.delta.kind === "text" ? event.delta.text : ""))
    .join("");
}

// ── SSE 报文构造 ────────────────────────────────────────────────────────────

/** LF 分帧的 SSE（Anthropic / Chat / Responses 实测形态）。 */
function sseLf(frames: readonly string[]): Uint8Array {
  return bytes(frames.map((frame) => `${frame}\n\n`).join(""));
}

/** CRLF 分帧的 SSE（CloudCode 实测就是 `\r\n\r\n`）。 */
function sseCrlf(frames: readonly string[]): Uint8Array {
  return bytes(frames.map((frame) => `${frame.replace(/\n/gu, "\r\n")}\r\n\r\n`).join(""));
}

function anthropicFrame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

function dataFrameText(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

// ── Windsurf 报文构造（真 protobuf + 真 Connect 信封） ──────────────────────

const windsurfSchema = getSharedWindsurfSchema();

function windsurfData(init: Record<string, unknown>): Uint8Array {
  return enframe(toBinary(windsurfSchema.responseDesc, create(windsurfSchema.responseDesc, init as never)));
}

function windsurfEnd(trailer: Record<string, unknown>): Uint8Array {
  const payload = bytes(JSON.stringify(trailer));
  const framed = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(framed.buffer);
  view.setUint8(0, 0b10);
  view.setUint32(1, payload.length, false);
  framed.set(payload, CONNECT_FRAME_HEADER_BYTES);
  return framed;
}

// ── 出口描述 ────────────────────────────────────────────────────────────────

const HUGE_TEXT = "喵".repeat(400_000); // ~1.2 MB UTF-8，跨越任何合理的 chunk 边界

interface OutboxFixture {
  readonly name: string;
  readonly outbox: IROutbox<IRWireBody>;
  readonly contentType: string;
  /** 一条完整成功的流。 */
  readonly complete: Uint8Array;
  /** 同一条流砍掉终止事件 —— 上游把连接掐了。 */
  readonly truncated: Uint8Array;
  /** 只有保活/纯遥测帧：连一个字的内容和终止都没有。 */
  readonly heartbeatOnly: Uint8Array;
  /** 完整流中间插一个**解析不出来**的帧。 */
  readonly withBadFrame: Uint8Array;
  /** 完整流中间插一个**类型没见过**的事件。 */
  readonly withUnknownEvent: Uint8Array;
  /** 终止事件出现两次。 */
  readonly doubleTerminal: Uint8Array;
  /** 单帧里塞下 1MB 文本。 */
  readonly hugeFrame: Uint8Array;
  /** 用 CRLF 重新分帧的同一条完整流（二进制出口为 null）。 */
  readonly completeCrlf: Uint8Array | null;
  readonly expectedText: string;
}

const anthropicOk: readonly string[] = [
  anthropicFrame("message_start", { message: { model: "claude-opus-4-8", usage: { input_tokens: 12, output_tokens: 0 } } }),
  anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "PO" } }),
  anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "NG" } }),
  anthropicFrame("content_block_stop", { index: 0 }),
  anthropicFrame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  anthropicFrame("message_stop", {}),
];

const chatOk: readonly string[] = [
  dataFrameText({ id: "c1", object: "chat.completion.chunk", model: "gpt-5.2", choices: [{ index: 0, delta: { role: "assistant" } }] }),
  dataFrameText({ id: "c1", choices: [{ index: 0, delta: { content: "PO" } }] }),
  dataFrameText({ id: "c1", choices: [{ index: 0, delta: { content: "NG" } }] }),
  dataFrameText({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  "data: [DONE]",
];

const responsesOk: readonly string[] = [
  dataFrameText({ type: "response.created", response: { model: "gpt-5.2" } }),
  dataFrameText({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
  dataFrameText({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PO" }),
  dataFrameText({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "NG" }),
  dataFrameText({ type: "response.content_part.done", output_index: 0, content_index: 0 }),
  dataFrameText({ type: "response.completed", response: { model: "gpt-5.2", status: "completed", usage: { input_tokens: 12, output_tokens: 2 } } }),
];

function geminiChunk(parts: readonly unknown[], finishReason?: string): unknown {
  return {
    response: {
      candidates: [{
        content: { role: "model", parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 },
      modelVersion: "gemini-3.6-flash",
    },
  };
}

const geminiOk: readonly string[] = [
  dataFrameText(geminiChunk([{ text: "PO" }])),
  dataFrameText(geminiChunk([{ text: "NG" }])),
  dataFrameText(geminiChunk([{ text: "" }], "STOP")),
];

const OUTBOX_FIXTURES: readonly OutboxFixture[] = [
  {
    name: "anthropic",
    outbox: createAnthropicOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "claude-test" }),
    contentType: "text/event-stream",
    complete: sseLf(anthropicOk),
    truncated: sseLf(anthropicOk.slice(0, 4)),
    heartbeatOnly: sseLf([anthropicFrame("ping", {}), anthropicFrame("ping", {}), ": keepalive"]),
    withBadFrame: sseLf([...anthropicOk.slice(0, 3), "event: content_block_delta\ndata: {\"type\":", ...anthropicOk.slice(3)]),
    withUnknownEvent: sseLf([...anthropicOk.slice(0, 3), anthropicFrame("container_status_2099", { id: "x" }), ...anthropicOk.slice(3)]),
    doubleTerminal: sseLf([...anthropicOk, anthropicFrame("message_delta", { delta: { stop_reason: "max_tokens" } }), anthropicFrame("message_stop", {})]),
    hugeFrame: sseLf([
      anthropicOk[0]!, anthropicOk[1]!,
      anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: HUGE_TEXT } }),
      anthropicOk[4]!, anthropicOk[5]!, anthropicOk[6]!,
    ]),
    completeCrlf: sseCrlf(anthropicOk),
    expectedText: "PONG",
  },
  {
    name: "openai_chat",
    outbox: createOpenAIChatOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    contentType: "text/event-stream",
    complete: sseLf(chatOk),
    truncated: sseLf(chatOk.slice(0, 3)),
    heartbeatOnly: sseLf([": keepalive", ": keepalive"]),
    withBadFrame: sseLf([...chatOk.slice(0, 2), "data: {\"choices\":", ...chatOk.slice(2)]),
    withUnknownEvent: sseLf([...chatOk.slice(0, 2), dataFrameText({ id: "c1", choices: [{ index: 0, delta: { audio_2099: "x" } }] }), ...chatOk.slice(2)]),
    doubleTerminal: sseLf([...chatOk.slice(0, 4), dataFrameText({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }), "data: [DONE]"]),
    hugeFrame: sseLf([chatOk[0]!, dataFrameText({ id: "c1", choices: [{ index: 0, delta: { content: HUGE_TEXT } }] }), chatOk[3]!, "data: [DONE]"]),
    completeCrlf: sseCrlf(chatOk),
    expectedText: "PONG",
  },
  {
    name: "openai_responses",
    outbox: createOpenAIResponsesOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    contentType: "text/event-stream",
    complete: sseLf(responsesOk),
    truncated: sseLf(responsesOk.slice(0, 4)),
    heartbeatOnly: sseLf([dataFrameText({ type: "keepalive" }), dataFrameText({ type: "keepalive" })]),
    withBadFrame: sseLf([...responsesOk.slice(0, 3), "data: {\"type\":", ...responsesOk.slice(3)]),
    withUnknownEvent: sseLf([...responsesOk.slice(0, 3), dataFrameText({ type: "response.audio_2099.delta", delta: "x" }), ...responsesOk.slice(3)]),
    doubleTerminal: sseLf([...responsesOk, dataFrameText({ type: "response.completed", response: { model: "gpt-5.2", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })]),
    hugeFrame: sseLf([
      responsesOk[0]!, responsesOk[1]!,
      dataFrameText({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: HUGE_TEXT }),
      responsesOk[4]!, responsesOk[5]!,
    ]),
    completeCrlf: sseCrlf(responsesOk),
    expectedText: "PONG",
  },
  {
    name: "gemini_cloudcode",
    outbox: createGeminiCloudCodeOutbox({
      model: "gemini-3.6-flash-high", accessToken: "ya29.t", project: "p",
      requestIdFactory: () => "agent/1/1/deadbeef/2",
    }),
    // CloudCode 的真实分帧就是 CRLF —— 这个出口的「正常」形态本身就是别人的边界情况。
    contentType: "text/event-stream",
    complete: sseCrlf(geminiOk),
    truncated: sseCrlf(geminiOk.slice(0, 2)),
    heartbeatOnly: sseCrlf([": keepalive", ": keepalive"]),
    withBadFrame: sseCrlf([geminiOk[0]!, "data: {\"response\":", ...geminiOk.slice(1)]),
    withUnknownEvent: sseCrlf([geminiOk[0]!, dataFrameText({ response: { promptRewrite_2099: {} } }), ...geminiOk.slice(1)]),
    doubleTerminal: sseCrlf([...geminiOk, dataFrameText(geminiChunk([{ text: "" }], "MAX_TOKENS"))]),
    hugeFrame: sseCrlf([dataFrameText(geminiChunk([{ text: HUGE_TEXT }])), geminiOk[2]!]),
    completeCrlf: sseLf(geminiOk), // 反向：LF 分帧的同一条流也必须切得开
    expectedText: "PONG",
  },
  {
    name: "windsurf",
    outbox: createWindsurfOutbox({ model: "claude-opus-4-8-high", apiKey: "devin-session-token$h.e.s" }),
    contentType: "application/connect+proto",
    complete: concat([windsurfData({ deltaText: "PO" }), windsurfData({ deltaText: "NG" }), windsurfEnd({})]),
    truncated: concat([windsurfData({ deltaText: "PO" }), windsurfData({ deltaText: "NG" })]),
    heartbeatOnly: concat([windsurfData({ latency: 12.5 }), windsurfData({ latency: 13.5 })]),
    withBadFrame: concat([
      windsurfData({ deltaText: "PO" }),
      enframe(new Uint8Array([0xff, 0xff, 0xff, 0xff])),
      windsurfData({ deltaText: "NG" }), windsurfEnd({}),
    ]),
    withUnknownEvent: concat([
      windsurfData({ deltaText: "PO" }), windsurfData({ latency: 1.5 }),
      windsurfData({ deltaText: "NG" }), windsurfEnd({}),
    ]),
    doubleTerminal: concat([
      windsurfData({ deltaText: "PO" }), windsurfData({ deltaText: "NG" }),
      windsurfEnd({}), windsurfEnd({ error: { code: "internal", message: "late" } }),
    ]),
    hugeFrame: concat([windsurfData({ deltaText: HUGE_TEXT }), windsurfEnd({})]),
    completeCrlf: null,
    expectedText: "PONG",
  },
];

function respond(outbox: OutboxFixture, payload: Uint8Array, chunkSize = payload.length || 1): Response {
  return new Response(streamed(payload, chunkSize), {
    status: 200,
    headers: { "content-type": outbox.contentType },
  });
}

/**
 * 红线检查：折出来的回合要么有内容、要么有错误，绝不允许「没内容也没错误」。
 * 这是本文件唯一一条对**每个**出口、**每种**故障都成立的性质。
 */
async function expectNoSilentSuccess(events: readonly IREvent[]): Promise<void> {
  const source = (async function* () { yield* events; })();
  const response = await assembleResponse(source, "fallback");
  const emitted = response.turn.parts.some(
    (part) => (part.kind === "text" && part.text.length > 0)
      || (part.kind === "thinking" && part.text.length > 0)
      || part.kind === "toolCall" || part.kind === "redactedThinking",
  );
  if (!emitted) {
    expect(response.error).not.toBeNull();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 对照组：正常流必须先是对的，否则下面的故障断言全都没有意义
// ═══════════════════════════════════════════════════════════════════════════

describe("对照组：完整流", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(`${outbox.name}：内容完整、以 messageStop 收尾、没有 error`, async () => {
      clearThoughtSignatureCache();
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.complete)));
      expect(textOf(events)).toBe(outbox.expectedText);
      expect(kinds(events)).toContain("messageStop");
      expect(events.some((event) => event.kind === "error")).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 空流 / 只有心跳 / 缺终止事件 —— 三种「什么都没发生」的形态
// ═══════════════════════════════════════════════════════════════════════════

describe("空流：200 + 零字节，绝不是成功", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      const events = await collect(outbox.outbox.readOutboxResponse(
        new Response(streamed(new Uint8Array(0), 1), { status: 200, headers: { "content-type": outbox.contentType } }),
      ));
      expect(events.some((event) => event.kind === "error")).toBe(true);
      expect(kinds(events)).not.toContain("messageStop");
      await expectNoSilentSuccess(events);
    });
  }
});

describe("body 为 null（HEAD 式响应 / 代理吞掉了 body）", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      const events = await collect(outbox.outbox.readOutboxResponse(
        new Response(null, { status: 200, headers: { "content-type": outbox.contentType } }),
      ));
      expect(events.some((event) => event.kind === "error")).toBe(true);
      expect(kinds(events)).not.toContain("messageStop");
      await expectNoSilentSuccess(events);
    });
  }
});

describe("只有心跳/遥测的流：连接是活的，但一个字都没产出", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.heartbeatOnly)));
      expect(events.some((event) => event.kind === "error")).toBe(true);
      expect(kinds(events)).not.toContain("messageStop");
      await expectNoSilentSuccess(events);
    });
  }
});

describe("终止事件缺失：内容发了一半，连接没了", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(`${outbox.name}：已到达的内容保留，但必须以 error 收尾`, async () => {
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.truncated)));
      const last = events.at(-1);
      expect(last?.kind).toBe("error");
      if (last?.kind === "error") {
        // 掐断是传输层事实，换个账号重来是有意义的。
        expect(last.error.retryable).toBe(true);
      }
      expect(kinds(events)).not.toContain("messageStop");
      // 已经到手的半截内容不许因为收尾失败就被丢掉。
      expect(textOf(events).length).toBeGreaterThan(0);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 帧被 TCP 切在任意位置
// ═══════════════════════════════════════════════════════════════════════════

describe("TCP 分片：切在任意字节上都必须解出同一串事件", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    for (const chunkSize of [1, 2, 3, 7, 64]) {
      it(`${outbox.name} / 每 ${chunkSize} 字节一刀`, async () => {
        clearThoughtSignatureCache();
        const whole = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.complete)));
        clearThoughtSignatureCache();
        const sliced = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.complete, chunkSize)));
        expect(sliced).toEqual(whole);
      });
    }
  }

  /**
   * 一字节一刀必然把 `\r\n` 切在 `\r` 与 `\n` 之间。孤立的 `\r` 落在缓冲末尾时
   * **不能**当成行结束符 —— 当成了就会在事件中间劈一刀，症状是内容凭空少一段。
   */
  for (const outbox of OUTBOX_FIXTURES) {
    if (outbox.completeCrlf === null) continue;
    it(`${outbox.name}：换一种行终止符分帧，逐字节切开仍解出同样的内容`, async () => {
      clearThoughtSignatureCache();
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.completeCrlf!, 1)));
      expect(textOf(events)).toBe(outbox.expectedText);
      expect(kinds(events)).toContain("messageStop");
    });
  }
});

describe("超大单帧：1MB 文本不许被分片逻辑截断", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      clearThoughtSignatureCache();
      // 8KB 一刀 —— 一帧要跨 150 个 chunk 才拼得回来。
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.hugeFrame, 8192)));
      expect(textOf(events)).toBe(HUGE_TEXT);
      expect(kinds(events)).toContain("messageStop");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 帧本身坏了 / 类型没见过
// ═══════════════════════════════════════════════════════════════════════════

describe("解析不出来的帧：进 unhandled，不静默丢，也不终止整条流", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      clearThoughtSignatureCache();
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.withBadFrame)));
      expect(kinds(events)).toContain("unhandled");
      // 坏帧之后的正常帧照常产出 —— 一个坏帧不该让后面的内容全部蒸发。
      expect(textOf(events)).toContain("NG");
      expect(kinds(events)).toContain("messageStop");
    });
  }
});

describe("没见过的事件类型：进 unhandled（不变量 4：不许有 switch 黑洞）", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      clearThoughtSignatureCache();
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.withUnknownEvent)));
      expect(kinds(events)).toContain("unhandled");
      expect(textOf(events)).toBe(outbox.expectedText);
      expect(kinds(events)).toContain("messageStop");
    });
  }
});

describe("终止事件出现两次：结局唯一且确定，不许把内容重放一遍", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(outbox.name, async () => {
      clearThoughtSignatureCache();
      const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox.doubleTerminal)));
      const source = (async function* () { yield* events; })();
      const assembled = await assembleResponse(source, "fallback");
      // 内容不因为多了一个终止事件而重复。
      expect(assembled.turn.parts.filter((part) => part.kind === "text")
        .map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe(outbox.expectedText);
      // 结局要么是一个确定的 stopReason，要么是一个明确的 error，不许两者都没有。
      expect(assembled.stopReason !== null || assembled.error !== null).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 事件乱序
// ═══════════════════════════════════════════════════════════════════════════

describe("事件乱序：partDelta 先于 partStart", () => {
  it("anthropic：上游先发 delta 再发 start，折叠时记 unhandled 而不是静默丢内容", async () => {
    const outbox = OUTBOX_FIXTURES[0]!;
    const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, sseLf([
      anthropicOk[0]!,
      anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "orphan" } }),
      anthropicOk[1]!,
      anthropicFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "kept" } }),
      anthropicOk[4]!, anthropicOk[5]!, anthropicOk[6]!,
    ]))));
    // 出口照实转发（它不重排上游的帧序），由唯一的折叠点表态。
    expect(kinds(events).slice(0, 3)).toEqual(["messageStart", "usage", "partDelta"]);
    const assembled = await assembleResponse((async function* () { yield* events; })(), "m");
    expect(assembled.unhandled.map((entry) => entry.rawType)).toContain("partDelta-without-partStart");
    expect(assembled.turn.parts).toEqual([{ kind: "text", text: "kept" }]);
  });

  it("anthropic：content_block_stop 先于 start —— 不许因此丢掉后来的内容", async () => {
    const outbox = OUTBOX_FIXTURES[0]!;
    const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, sseLf([
      anthropicOk[0]!,
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicOk[1]!, anthropicOk[2]!, anthropicOk[3]!, anthropicOk[4]!,
      anthropicOk[5]!, anthropicOk[6]!,
    ]))));
    const assembled = await assembleResponse((async function* () { yield* events; })(), "m");
    expect(assembled.turn.parts).toEqual([{ kind: "text", text: "PONG" }]);
    expect(assembled.stopReason).toBe("endTurn");
  });

  it("delta 的种类与已开的块不匹配时进 unhandled，不硬塞进去", async () => {
    const events: IREvent[] = [
      { kind: "partStart", index: 0, part: { kind: "text", text: "" } },
      { kind: "partDelta", index: 0, delta: { kind: "thinking", text: "wrong slot" } },
      { kind: "messageStop", reason: "endTurn" },
    ];
    const assembled = await assembleResponse((async function* () { yield* events; })(), "m");
    expect(assembled.unhandled.map((entry) => entry.rawType)).toEqual(["partDelta:thinking-on-text"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 传输层断连：提交前 vs 提交后
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 断连的两种时点在**语义上完全不同**：
 *   提交前 —— 还没有任何字节下发，换号重试是安全的；
 *   提交后 —— 字节已经在客户端手里，只能在 200 流里补一个协议内的 error 收尾。
 *
 * 这里断言的是红线（不许假成功）。至于「断连变成 error 事件而不是异常」，
 * 见文件末尾那组守卫用例。
 */
describe("传输层断连", () => {
  for (const outbox of OUTBOX_FIXTURES) {
    it(`${outbox.name}：首字节前断开，绝不产出假成功`, async () => {
      let threw = false;
      let events: IREvent[] = [];
      try {
        events = await collect(outbox.outbox.readOutboxResponse(
          new Response(severed(null), { status: 200, headers: { "content-type": outbox.contentType } }),
        ));
      } catch { threw = true; }
      expect(threw || events.some((event) => event.kind === "error")).toBe(true);
      expect(kinds(events)).not.toContain("messageStop");
    });

    it(`${outbox.name}：内容发了一半断开，绝不产出假成功`, async () => {
      // 完整流的前 60% —— 一定切在某个帧的中间。
      const prefix = outbox.complete.slice(0, Math.floor(outbox.complete.length * 0.6));
      let threw = false;
      let events: IREvent[] = [];
      try {
        events = await collect(outbox.outbox.readOutboxResponse(
          new Response(severed(prefix), { status: 200, headers: { "content-type": outbox.contentType } }),
        ));
      } catch { threw = true; }
      expect(threw || events.some((event) => event.kind === "error")).toBe(true);
      expect(kinds(events)).not.toContain("messageStop");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 红线总检
// ═══════════════════════════════════════════════════════════════════════════

describe("红线：任何故障流都不许折出「没内容也没错误」的回合", () => {
  const faults = ["truncated", "heartbeatOnly", "withBadFrame", "doubleTerminal"] as const;
  for (const outbox of OUTBOX_FIXTURES) {
    for (const fault of faults) {
      it(`${outbox.name} / ${fault}`, async () => {
        clearThoughtSignatureCache();
        const events = await collect(outbox.outbox.readOutboxResponse(respond(outbox, outbox[fault])));
        await expectNoSilentSuccess(events);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 传输层断连
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `readOutboxResponse` 的契约是 `AsyncIterable<IREvent>`，而 `IREvent` 里有 `error`
 * 这一态；`response.ts` 写得很明白：「上游的失败是数据（error），不是控制流」。
 *
 * **传输层**的失败（TCP reset、TLS 中断、上游进程被杀）也必须落在这条契约里：
 * `superviseUpstreamStream` 把上游迭代器抛出来的异常就地转成 error 事件。
 * 为什么这不只是「调用方 try/catch 一下」：**提交之后**下游已经收到 200 与部分字节，
 * 此时唯一正确的收尾是往同一条流里补一个协议内的 error 事件（stream_guard 的文件头
 * 就是这么写的）。异常穿过守卫意味着守卫维护的提交点状态在最需要它的那一刻失效，
 * 每个调用方都得自己重新实现一遍「我提交了没有」。
 *
 * 这两条曾经挂在「已知缺陷」下失败，但失败的是**夹具**不是实现：
 * `controller.error()` 会连同队列一起丢掉刚 enqueue 的前缀（见 `severed` 的注释），
 * 于是「提交后断连」这个场景根本没被构造出来 —— 读端在收到任何字节之前就拿到了异常。
 */
describe("传输层断连变成 error 事件，而不是异常", () => {
  it("DEFECT-6 提交后断连：守卫补一条协议内的 error 事件收尾", async () => {
    const outbox = OUTBOX_FIXTURES[0]!;
    const prefix = sseLf(anthropicOk.slice(0, 4));
    const response = new Response(severed(prefix), {
      status: 200, headers: { "content-type": outbox.contentType },
    });
    const events = await collect(superviseUpstreamStream(outbox.outbox.readOutboxResponse(response)));
    expect(kinds(events)).toContain("committed");
    expect(events.at(-1)?.kind).toBe("error");
  });

  it("DEFECT-6 提交前断连：同样应当是一条可重试的 error 事件", async () => {
    const outbox = OUTBOX_FIXTURES[0]!;
    const response = new Response(severed(null), {
      status: 200, headers: { "content-type": outbox.contentType },
    });
    const events = await collect(superviseUpstreamStream(outbox.outbox.readOutboxResponse(response)));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "transport", retryable: true } });
  });
});
