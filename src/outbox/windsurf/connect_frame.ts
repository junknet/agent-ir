/**
 * Connect 协议的信封帧 —— 这个出口与前四个的第一处结构性差别。
 *
 * 前四家都是「另一种 JSON SSE」：帧边界是 `\n\n`，内容是文本，切错了顶多解析失败。
 * Connect 的流是**长度前缀的二进制帧**：
 *
 *     [flag:1][len:4 大端][payload:len]
 *
 * 没有分隔符可找 —— 长度读错一个字节，后面整条流全部错位，而且不会报错，
 * 只会解出一串合法但语义乱套的 protobuf。所以这里不做任何「尽力而为」的容错：
 * 头不满 5 字节就等，payload 不满 len 就等，剩下的残留字节原样留在缓冲里由调用方判死。
 *
 * flag 是位图，**不是**枚举：
 *   bit0 (1) = payload 被压缩（Connect 的 `compression` 协商）
 *   bit1 (2) = 结束帧，payload 是 JSON trailer
 * 生产实测只见过 0 与 2。但 `flag === 0` 与 `flag & 2` 这两个判断**合起来不覆盖全集**
 * （3 = 压缩的结束帧，1 = 压缩的数据帧都落在外面），所以调用方必须有兜底分支：
 * 一个压缩数据帧被当成裸 protobuf 去解，得到的是垃圾，不是错误。
 *
 * wire 知识来自生产实现 `packages/windsurf_protocol/src/connect_frame.ts`。
 */

export interface ConnectFrame {
  readonly flag: number;
  readonly payload: Uint8Array;
}

export const CONNECT_FLAG_COMPRESSED = 0b1;
export const CONNECT_FLAG_END_STREAM = 0b10;

/** 帧头固定 5 字节：1 字节 flag + 4 字节大端长度。 */
export const CONNECT_FRAME_HEADER_BYTES = 5;

/** 单条消息 → 一个 flag=0 的数据帧。请求侧只用得到这一种。 */
export function enframe(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + message.length);
  const view = new DataView(framed.buffer);
  view.setUint8(0, 0);
  view.setUint32(1, message.length, false);
  framed.set(message, CONNECT_FRAME_HEADER_BYTES);
  return framed;
}

/**
 * 切帧游标暴露给调用方的状态。
 *
 * `residualBytes` 是流结束时缓冲里剩下的、**不足以构成一帧**的字节数。
 * 它不是诊断信息而是判据：>0 = 连接在一帧中间被掐断（半个长度前缀、半个 payload），
 * 与「干净地少了个结束帧」是两种不同的故障，错误文案要能区分。
 */
export interface ConnectDeframeState {
  residualBytes: number;
  frameCount: number;
}

export function createDeframeState(): ConnectDeframeState {
  return { residualBytes: 0, frameCount: 0 };
}

/**
 * 增量字节流 → 逐帧产出。跨 chunk 的半帧自动缓冲。
 *
 * 一个 chunk 里可能有 0 个、1 个或 n 个完整帧，也可能只有半个帧头 —— 三种情况必须
 * 都对。实测上游确实会把一帧拆到两个 TCP chunk 里（生产 `connect_frame.test.ts`
 * 的「跨 chunk 半帧自动缓冲」就是为此写的）。
 */
export async function* deframe(
  chunks: AsyncIterable<Uint8Array>,
  state: ConnectDeframeState = createDeframeState(),
): AsyncGenerator<ConnectFrame> {
  let buffer = new Uint8Array(0);
  for await (const chunk of chunks) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= CONNECT_FRAME_HEADER_BYTES) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
      const flag = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (buffer.length < CONNECT_FRAME_HEADER_BYTES + length) break;
      state.frameCount += 1;
      yield {
        flag,
        payload: buffer.slice(CONNECT_FRAME_HEADER_BYTES, CONNECT_FRAME_HEADER_BYTES + length),
      };
      buffer = buffer.slice(CONNECT_FRAME_HEADER_BYTES + length);
    }
  }
  state.residualBytes = buffer.length;
}

/**
 * 结束帧的 JSON trailer。
 *
 * **上游的应用错误就住在这里，而且 HTTP 状态码是 200。** 形态（生产实测）：
 *   `{"error":{"code":"permission_denied","message":"an internal error occurred"}}`
 * 干净收尾则是 `{}` 或 `{"metadata":{...}}`。
 *
 * 解析失败**不能**当成干净收尾 —— 那正是「200 但空」的来源。所以返回判别联合，
 * 让调用方必须表态。
 */
export type ConnectTrailer =
  | { readonly ok: true; readonly trailer: Record<string, unknown> }
  | { readonly ok: false; readonly rawText: string };

export function parseConnectTrailer(payload: Uint8Array): ConnectTrailer {
  if (payload.length === 0) return { ok: true, trailer: {} };
  const rawText = new TextDecoder().decode(payload);
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, rawText };
    }
    return { ok: true, trailer: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, rawText };
  }
}

/** `Response.body` → 字节块异步序列。ReadableStream 的锁在这里收口，不外泄。 */
export function readableToChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
