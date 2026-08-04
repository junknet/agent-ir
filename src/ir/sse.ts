/** SSE 原语。解析与生成各一处，三个协议共用。 */

export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
}

/**
 * 按 SSE 规范切帧：事件以空行分隔，`data:` 行可多行累加。
 *
 * 关键点是**跨 chunk 的残留缓冲**：上游的 TCP 分片与事件边界无关，一个事件常被切成
 * 两三个 chunk。按 chunk 独立解析会静默丢掉半个事件 —— 这类丢帧在流式里表现为
 * 「回答少了一段」，最难查。
 */
export async function* iterateSse(response: Response): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(raw);
      if (parsed !== null) yield parsed;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  // 上游没有以空行收尾时，残留的最后一个事件仍然要发出去，不能因为「格式不完美」丢内容。
  const tail = parseSseBlock(buffer);
  if (tail !== null) yield tail;
}

function parseSseBlock(raw: string): SseEvent | null {
  const lines = raw.split("\n");
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.length === 0 || normalized.startsWith(":")) continue;
    const colon = normalized.indexOf(":");
    const field = colon === -1 ? normalized : normalized.slice(0, colon);
    const value = colon === -1 ? "" : normalized.slice(colon + 1).replace(/^ /u, "");
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
