/**
 * SSE 分帧。
 *
 * 这组用例来自一次真实故障：`iterateSse` 原本按 `indexOf("\n\n")` 找帧边界，
 * 而 Google CloudCode 的 `v1internal:streamGenerateContent` 用 **CRLF**（`\r\n\r\n`）分帧，
 * 结果整条流被攒成一个 block、多个 JSON 首尾相接。**症状不是报错，是整轮内容凭空消失。**
 *
 * 对照官方 OpenAI Go SDK（`packages/ssestream`）确认了正确做法：逐行扫描、遇空行分帧，
 * 不做字节对匹配 —— 规范允许 `\r\n` / `\n` / `\r` 三种行终止符。
 */
import { describe, expect, it } from "bun:test";
import { iterateSse, type SseEvent } from "../src/ir/sse.ts";

function responseOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }));
}

async function collect(chunks: readonly string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of iterateSse(responseOf(chunks))) events.push(event);
  return events;
}

describe("行终止符", () => {
  it("LF 分帧", async () => {
    expect(await collect(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']))
      .toEqual([{ event: null, data: '{"a":1}' }, { event: null, data: '{"a":2}' }]);
  });

  it("CRLF 分帧 —— 真实故障形态（CloudCode）", async () => {
    expect(await collect(['data: {"a":1}\r\n\r\n', 'data: {"a":2}\r\n\r\n']))
      .toEqual([{ event: null, data: '{"a":1}' }, { event: null, data: '{"a":2}' }]);
  });

  it("裸 CR 分帧（规范允许的第三种）", async () => {
    expect(await collect(['data: {"a":1}\r\r', 'data: {"a":2}\r\r']))
      .toEqual([{ event: null, data: '{"a":1}' }, { event: null, data: '{"a":2}' }]);
  });

  it("同一条流里混用 LF 与 CRLF", async () => {
    expect(await collect(['data: a\n\ndata: b\r\n\r\ndata: c\n\n']))
      .toEqual([
        { event: null, data: "a" }, { event: null, data: "b" }, { event: null, data: "c" },
      ]);
  });
});

describe("跨 chunk 的残留缓冲", () => {
  it("TCP 把一个事件切成任意多片都能重组", async () => {
    expect(await collect(["dat", "a: ", '{"a"', ":1}", "\n", "\n"]))
      .toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it("CRLF 恰好被切在 \\r 与 \\n 之间 —— 孤立 \\r 不能当成帧边界", async () => {
    // 这是最阴的一种：把 \r 当行尾立刻分帧，会在后续 \n 上再切一次，多出一个空事件。
    expect(await collect(['data: {"a":1}\r', '\n\r', "\n"]))
      .toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it("多个事件挤在一个 chunk 里", async () => {
    expect(await collect(["data: a\n\ndata: b\n\ndata: c\n\n"]))
      .toEqual([
        { event: null, data: "a" }, { event: null, data: "b" }, { event: null, data: "c" },
      ]);
  });
});

describe("字段解析", () => {
  it("event 与多行 data 累加，冒号后单个空格被吃掉", async () => {
    expect(await collect(["event: message_start\ndata: line1\ndata: line2\n\n"]))
      .toEqual([{ event: "message_start", data: "line1\nline2" }]);
  });

  it("注释行与无冒号字段不产出内容", async () => {
    expect(await collect([": keep-alive comment\n\ndata: real\n\n"]))
      .toEqual([{ event: null, data: "real" }]);
  });

  it("data 值里的冒号不被截断（JSON 必须原样保留）", async () => {
    expect(await collect(['data: {"url":"https://x.example/a:b"}\n\n']))
      .toEqual([{ event: null, data: '{"url":"https://x.example/a:b"}' }]);
  });
});

describe("收尾", () => {
  it("上游没有以空行收尾时，最后一个事件仍然发出 —— 不因格式不完美丢内容", async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"a":2}']))
      .toEqual([{ event: null, data: '{"a":1}' }, { event: null, data: '{"a":2}' }]);
  });

  it("空 body 不产出任何事件", async () => {
    const events: SseEvent[] = [];
    for await (const event of iterateSse(new Response(null))) events.push(event);
    expect(events).toEqual([]);
  });

  it("只有空行的流不产出空事件", async () => {
    expect(await collect(["\n\n\r\n\r\n"])).toEqual([]);
  });
});
