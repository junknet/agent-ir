/** SSE 原语。解析与生成各一处，三个协议共用。 */
import type { CompleteOutboxSseFrameInspector } from "./ir_message_interception_extensions.ts";

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * 按 SSE 规范切帧：事件以空行分隔，`data:` 行可多行累加。
 *
 * 关键点是**跨 chunk 的残留缓冲**：上游的 TCP 分片与事件边界无关，一个事件常被切成
 * 两三个 chunk。按 chunk 独立解析会静默丢掉半个事件 —— 这类丢帧在流式里表现为
 * 「回答少了一段」，最难查。
 */
export async function* iterateSse(
  response: Response, inspectCompleteSseFrame?: CompleteOutboxSseFrameInspector,
): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];

  const takeLine = (): string | null => {
    // 规范允许三种行终止符：\r\n、\n、\r。只找 "\n\n" 会漏掉 CRLF 分帧的上游 ——
    // 实测 Google CloudCode 的 v1internal:streamGenerateContent 就是 \r\n\r\n，
    // 结果整条流被攒成一个 block、多个 JSON 首尾相接，**症状不是报错是内容凭空消失**。
    // 官方 SDK 的做法同样是逐行扫描 + 空行分帧，不做字节对匹配。
    const match = /\r\n|\n|\r/u.exec(buffer);
    if (match === null) return null;
    // 落在缓冲末尾的孤立 \r 可能是 \r\n 被 TCP 切开的前半截，等下一个 chunk 再判。
    if (match[0] === "\r" && match.index === buffer.length - 1) return null;
    const line = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    return line;
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let line = takeLine(); line !== null; line = takeLine()) {
      if (line.length > 0) { pending.push(line); continue; }
      const parsed = parseSseLines(pending);
      pending = [];
      if (parsed !== null) {
        await inspectCompleteSseFrame?.(parsed);
        yield parsed;
      }
    }
  }

  buffer += decoder.decode();
  for (let line = takeLine(); line !== null; line = takeLine()) {
    if (line.length > 0) { pending.push(line); continue; }
    const parsed = parseSseLines(pending);
    pending = [];
    if (parsed !== null) {
      await inspectCompleteSseFrame?.(parsed);
      yield parsed;
    }
  }
  if (buffer.length > 0) pending.push(buffer);
  // 上游没有以空行收尾时，残留的最后一个事件仍然要发出去，不能因为「格式不完美」丢内容。
  const tail = parseSseLines(pending);
  if (tail !== null) {
    await inspectCompleteSseFrame?.(tail);
    yield tail;
  }
}

function parseSseLines(lines: readonly string[]): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === null) return null;
  return { event, data: data.join("\n") };
}

export function tryParseJson<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
