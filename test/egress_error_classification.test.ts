/**
 * 上游错误分类 —— 五个出口 × HTTP 层 / 协议内两条路径。
 *
 * 为什么这件事值得单独一组：`IRUpstreamError` 的两个字段决定了调用方的**全部**动作。
 *   `kind`      → 换不换账号、要不要降级、给客户端回几号状态码
 *   `retryable` → 退避重试还是当场失败
 * 分错一档的代价在生产里是可量化的：`permission_denied` 被当成资源错误重试，
 * 会打遍整个账号池，最后以一个假的 `503 pool_exhausted` 回给客户端 —— 客户端于是继续
 * 退避重试，而真实原因是**这条请求本身**永远不会被接受。
 *
 * 三条跨出口的硬性质（对每个出口的每一种分类都断言）：
 *   1. `permissionDenied` / `invalidRequest` / `contentPolicy` / `contextLengthExceeded`
 *      **永不可重试** —— 重发同一条请求必然重演同一个失败。
 *   2. `quotaExhausted` **永不可重试** —— 配额是账号的状态，换账号是调度决定，不是这条错误的属性。
 *   3. `kind` 必须落在类型的封闭集里，`raw` 必须留住上游原话（诊断链路不能断）。
 *
 * 特别注意 **windsurf 的错误住在 Connect 尾帧里，HTTP 是 200** —— 它是唯一一个
 * 「传输层完全正常但请求已经失败」的出口，也是这一组测试存在的直接原因。
 */
import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { createAnthropicUpstream } from "../src/egress/anthropic.ts";
import { createChatCompletionsUpstream } from "../src/egress/openai_chat_completions.ts";
import { createResponsesUpstream } from "../src/egress/openai_responses.ts";
import { createGeminiCloudCodeUpstream } from "../src/egress/gemini_cloudcode.ts";
import { createWindsurfUpstream } from "../src/egress/windsurf/index.ts";
import { CONNECT_FRAME_HEADER_BYTES, enframe } from "../src/egress/windsurf/connect_frame.ts";
import { getSharedWindsurfSchema } from "../src/egress/windsurf/schema.ts";
import type { IREgress, IREvent, IRUpstreamError, IRWireBody } from "../src/ir/types.ts";

// ── 工具 ────────────────────────────────────────────────────────────────────

const ALL_KINDS: readonly IRUpstreamError["kind"][] = [
  "invalidRequest", "permissionDenied", "rateLimited", "quotaExhausted",
  "contextLengthExceeded", "contentPolicy", "upstreamUnavailable", "transport", "unknown",
];

/** 重发同一条请求必然重演的那几档 —— 它们**永远**不可重试。 */
const NEVER_RETRYABLE: ReadonlySet<IRUpstreamError["kind"]> = new Set<IRUpstreamError["kind"]>([
  "invalidRequest", "permissionDenied", "contentPolicy", "contextLengthExceeded", "quotaExhausted",
]);

async function collect(events: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** 取出流里唯一的那条错误。没有错误就是测试要抓的失败本身，所以直接报出来。 */
async function errorOf(events: AsyncIterable<IREvent>): Promise<IRUpstreamError> {
  const collected = await collect(events);
  const found = collected.find((event) => event.kind === "error");
  if (found === undefined || found.kind !== "error") {
    throw new Error(`expected an error event, got: ${collected.map((event) => event.kind).join(",")}`);
  }
  // 三条通用不变量在这里一次性把关，每个用例不必各写一遍。
  expect(ALL_KINDS).toContain(found.error.kind);
  if (NEVER_RETRYABLE.has(found.error.kind)) expect(found.error.retryable).toBe(false);
  expect(found.error.message.length).toBeGreaterThan(0);
  return found.error;
}

function httpResponse(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function sseResponse(frames: readonly string[]): Response {
  return new Response(frames.map((frame) => `${frame}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

const anthropic = createAnthropicUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
const chat = createChatCompletionsUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
const responses = createResponsesUpstream({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
const gemini = createGeminiCloudCodeUpstream({
  model: "gemini-3.6-flash", accessToken: "t", project: "p", requestIdFactory: () => "r",
});
const windsurf = createWindsurfUpstream({ model: "claude-opus-4-8-high", apiKey: "devin$h.e.s" });

const EGRESSES: Readonly<Record<string, IREgress<IRWireBody>>> = {
  anthropic, openai_chat: chat, openai_responses: responses, gemini_cloudcode: gemini, windsurf,
};

// ── windsurf 报文 ───────────────────────────────────────────────────────────

const windsurfSchema = getSharedWindsurfSchema();

function windsurfData(init: Record<string, unknown>): Uint8Array {
  return enframe(toBinary(windsurfSchema.responseDesc, create(windsurfSchema.responseDesc, init as never)));
}

function windsurfEnd(trailer: Record<string, unknown>): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(trailer));
  const framed = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(framed.buffer);
  view.setUint8(0, 0b10);
  view.setUint32(1, payload.length, false);
  framed.set(payload, CONNECT_FRAME_HEADER_BYTES);
  return framed;
}

function windsurfStream(parts: readonly Uint8Array[]): Response {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return new Response(body, { status: 200, headers: { "content-type": "application/connect+proto" } });
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 层
// ═══════════════════════════════════════════════════════════════════════════

describe("HTTP 4xx/5xx：带上游原文错误体", () => {
  const cases: readonly {
    readonly status: number;
    readonly body: (provider: string) => string;
    readonly expect: IRUpstreamError["kind"];
  }[] = [
    {
      status: 400, expect: "invalidRequest",
      body: () => JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_request", message: "messages: at least one message is required" } }),
    },
    {
      status: 401, expect: "permissionDenied",
      body: () => JSON.stringify({ error: { type: "authentication_error", code: "invalid_api_key", message: "invalid x-api-key" } }),
    },
    {
      status: 403, expect: "permissionDenied",
      body: () => JSON.stringify({ error: { type: "permission_error", code: "permission_denied", message: "not allowed" } }),
    },
    {
      status: 429, expect: "rateLimited",
      body: () => JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down" } }),
    },
    {
      status: 500, expect: "upstreamUnavailable",
      body: () => JSON.stringify({ error: { type: "api_error", code: "server_error", message: "internal" } }),
    },
    {
      status: 503, expect: "upstreamUnavailable",
      body: () => JSON.stringify({ error: { type: "overloaded_error", code: "overloaded", status: "UNAVAILABLE", message: "overloaded" } }),
    },
  ];

  for (const [name, egress] of Object.entries(EGRESSES)) {
    for (const testCase of cases) {
      it(`${name} / HTTP ${testCase.status} → ${testCase.expect}`, async () => {
        const error = await errorOf(egress.readUpstreamResponse(
          httpResponse(testCase.status, testCase.body(name)),
        ));
        expect(error.kind).toBe(testCase.expect);
        expect(error.httpStatus).toBe(testCase.status);
        // 原话必须留住：分类是给机器看的，raw 是给人排障用的。
        expect(error.raw).not.toBeNull();
      });
    }
  }
});

describe("HTTP 层的重试判定与 kind 严格对齐", () => {
  for (const [name, egress] of Object.entries(EGRESSES)) {
    it(`${name}：429 与 5xx 可重试，4xx（除 429）一律不可`, async () => {
      const rateLimited = await errorOf(egress.readUpstreamResponse(httpResponse(429,
        JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }))));
      expect(rateLimited.retryable).toBe(true);

      const unavailable = await errorOf(egress.readUpstreamResponse(httpResponse(503,
        JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }))));
      expect(unavailable.retryable).toBe(true);

      const invalid = await errorOf(egress.readUpstreamResponse(httpResponse(400,
        JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }))));
      expect(invalid.retryable).toBe(false);
    });
  }
});

describe("上下文超长必须自己成一档 —— 它不是普通的 400", () => {
  /**
   * 生产实测：一天 126 次 `context_length_exceeded` 被当成通用错误静默跳过，
   * 调用方只能盲重试。它与 `invalidRequest` 的处置完全不同（前者要压缩上下文，
   * 后者要改请求），所以必须是独立的一档。
   */
  const cases: readonly [string, IREgress<IRWireBody>, number, string][] = [
    ["openai_chat", chat, 400, JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "This model's maximum context length is 272000 tokens" } })],
    ["openai_responses", responses, 400, JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "input too long" } })],
    ["gemini_cloudcode", gemini, 400, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count exceeds the maximum" } })],
  ];

  for (const [name, egress, status, body] of cases) {
    it(name, async () => {
      const error = await errorOf(egress.readUpstreamResponse(httpResponse(status, body)));
      expect(error.kind).toBe("contextLengthExceeded");
      expect(error.retryable).toBe(false);
    });
  }

  it("windsurf：上下文超长藏在 Connect 尾帧的 invalid_argument 里", async () => {
    const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfData({ deltaText: "" }),
      windsurfEnd({ error: { code: "invalid_argument", message: "prompt is too long for the context window" } }),
    ])));
    expect(error.kind).toBe("contextLengthExceeded");
    expect(error.retryable).toBe(false);
  });
});

describe("配额耗尽与限流分得开", () => {
  const cases: readonly [string, IREgress<IRWireBody>, Response][] = [
    ["openai_chat", chat, httpResponse(429, JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } }))],
    ["openai_responses", responses, httpResponse(429, JSON.stringify({ error: { code: "insufficient_quota", message: "quota exceeded" } }))],
    ["gemini_cloudcode", gemini, httpResponse(429, JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" } }))],
  ];

  for (const [name, egress, response] of cases) {
    it(`${name}：命中配额词 → quotaExhausted 且不可重试`, async () => {
      const error = await errorOf(egress.readUpstreamResponse(response));
      expect(error.kind).toBe("quotaExhausted");
      expect(error.retryable).toBe(false);
    });
  }

  it("gemini：同样是 RESOURCE_EXHAUSTED，不带配额词就是限流（可重试）", async () => {
    const error = await errorOf(gemini.readUpstreamResponse(httpResponse(429,
      JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests" } }))));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryable).toBe(true);
  });

  it("windsurf：resource_exhausted 靠文案二分，配额档不可重试", async () => {
    const quota = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfEnd({ error: { code: "resource_exhausted", message: "out of credits" } }),
    ])));
    expect(quota.kind).toBe("quotaExhausted");
    expect(quota.retryable).toBe(false);

    const throttled = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfEnd({ error: { code: "resource_exhausted", message: "too many concurrent requests" } }),
    ])));
    expect(throttled.kind).toBe("rateLimited");
    expect(throttled.retryable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 协议内错误：HTTP 是 200，失败在流里
// ═══════════════════════════════════════════════════════════════════════════

describe("协议内错误：HTTP 200，但这一轮已经失败了", () => {
  it("anthropic：SSE 里的 error 事件终止本轮，不再补 transport 错误", async () => {
    const events = await collect(anthropic.readUpstreamResponse(sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ])));
    const errors = events.filter((event) => event.kind === "error");
    // 恰好一条：既不吞掉，也不因为「没等到终止事件」再追加一条 transport。
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "error", error: { kind: "upstreamUnavailable", retryable: true, httpStatus: null } });
  });

  it("openai_chat：chunk 里的 error 字段同样是终止", async () => {
    const error = await errorOf(chat.readUpstreamResponse(sseResponse([
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"partial"}}]}',
      'data: {"error":{"type":"server_error","code":"server_error","message":"upstream hiccup"}}',
    ])));
    expect(error.kind).toBe("upstreamUnavailable");
    expect(error.httpStatus).toBeNull();
  });

  it("openai_responses：response.failed 里的 context_length_exceeded 必须显形", async () => {
    const error = await errorOf(responses.readUpstreamResponse(sseResponse([
      'data: {"type":"response.created","response":{"model":"m"}}',
      'data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too long"}}}',
    ])));
    expect(error.kind).toBe("contextLengthExceeded");
    expect(error.retryable).toBe(false);
  });

  it("openai_responses：顶层 error 事件是另一条失败路径，分类相同", async () => {
    const error = await errorOf(responses.readUpstreamResponse(sseResponse([
      'data: {"type":"error","code":"rate_limit_exceeded","message":"slow down"}',
    ])));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryable).toBe(true);
  });

  it("gemini：200 的 SSE 里直接塞 {error} —— 内容策略与鉴权都走这条", async () => {
    const denied = await errorOf(gemini.readUpstreamResponse(new Response(
      `data: ${JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "caller lacks permission" } })}\r\n\r\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    expect(denied.kind).toBe("permissionDenied");
    expect(denied.retryable).toBe(false);
  });

  it("gemini：promptFeedback.blockReason → contentPolicy 且不可重试", async () => {
    const error = await errorOf(gemini.readUpstreamResponse(new Response(
      `data: ${JSON.stringify({ response: { promptFeedback: { blockReason: "SAFETY" } } })}\r\n\r\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    expect(error.kind).toBe("contentPolicy");
    expect(error.retryable).toBe(false);
  });

  it("gemini：数组包一层的错误体也要认，否则 message 退化成 'upstream error'", async () => {
    const error = await errorOf(gemini.readUpstreamResponse(httpResponse(429,
      JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for X" } }]))));
    expect(error.kind).toBe("quotaExhausted");
    expect(error.message).toContain("Quota exceeded");
  });
});

describe("windsurf：错误在 Connect 尾帧里，HTTP 永远是 200", () => {
  it("permission_denied 不可重试 —— 重试会打遍账号池并伪装成 503", async () => {
    const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfData({ deltaText: "thinking" }),
      windsurfEnd({ error: { code: "permission_denied", message: "an internal error occurred" } }),
    ])));
    expect(error.kind).toBe("permissionDenied");
    expect(error.retryable).toBe(false);
    // httpStatus 恒为 null：上游给的就是 200，编一个 403 会让整条诊断链路失真。
    expect(error.httpStatus).toBeNull();
  });

  it("瞬时码可重试，请求码不可重试 —— 逐个 Connect code 表态", async () => {
    const expectations: readonly [string, IRUpstreamError["kind"], boolean][] = [
      ["unavailable", "upstreamUnavailable", true],
      ["internal", "upstreamUnavailable", true],
      ["deadline_exceeded", "upstreamUnavailable", true],
      ["aborted", "upstreamUnavailable", true],
      ["unknown", "upstreamUnavailable", true],
      ["canceled", "transport", true],
      ["invalid_argument", "invalidRequest", false],
      ["failed_precondition", "invalidRequest", false],
      ["not_found", "invalidRequest", false],
      ["unimplemented", "invalidRequest", false],
      ["unauthenticated", "permissionDenied", false],
      ["permission_denied", "permissionDenied", false],
    ];
    for (const [code, kind, retryable] of expectations) {
      const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
        windsurfEnd({ error: { code, message: `stream error: ${code}` } }),
      ])));
      expect({ code, kind: error.kind, retryable: error.retryable }).toEqual({ code, kind, retryable });
    }
  });

  it("数字 gRPC 码与 SCREAMING_SNAKE 归一到同一档", async () => {
    for (const code of [7, "7", "PERMISSION_DENIED", "permission_denied"]) {
      const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
        windsurfEnd({ error: { code, message: "denied" } }),
      ])));
      expect(error.kind).toBe("permissionDenied");
    }
  });

  it("尾帧里的字符串错误也是错误，不能当干净收尾", async () => {
    const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfData({ deltaText: "x" }),
      windsurfEnd({ error: "something went wrong" }),
    ])));
    expect(error.message).toBe("something went wrong");
    expect(error.kind).toBe("unknown");
  });

  it("认不出的 Connect code 落到 unknown 而不是某个默认档", async () => {
    const error = await errorOf(windsurf.readUpstreamResponse(windsurfStream([
      windsurfEnd({ error: { code: "quantum_flux_2099", message: "?" } }),
    ])));
    expect(error.kind).toBe("unknown");
  });

  it("HTTP 层错误与尾帧错误是两条路径：前者带真状态码", async () => {
    const error = await errorOf(windsurf.readUpstreamResponse(
      httpResponse(403, JSON.stringify({ code: "permission_denied", message: "bad session" })),
    ));
    expect(error.kind).toBe("permissionDenied");
    expect(error.httpStatus).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 错误体不是 JSON —— 网关/CDN 插进来的那一层
// ═══════════════════════════════════════════════════════════════════════════

describe("错误体不是 JSON（nginx 502 页 / Cloudflare 纯文本）", () => {
  const NGINX = "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>";

  for (const [name, egress] of Object.entries(EGRESSES)) {
    it(`${name}：仍要产出一条错误，且 raw 留住原文`, async () => {
      const error = await errorOf(egress.readUpstreamResponse(httpResponse(502, NGINX, "text/html")));
      expect(error.httpStatus).toBe(502);
      expect(JSON.stringify(error.raw)).toContain("502 Bad Gateway");
    });
  }

  it("空错误体（连一个字节都没有）也不能崩", async () => {
    for (const [, egress] of Object.entries(EGRESSES)) {
      const error = await errorOf(egress.readUpstreamResponse(httpResponse(503, "", "text/plain")));
      expect(error.httpStatus).toBe(503);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 已知缺陷 —— 断言的是应有行为，当前实现做不到，故意保留失败
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `src/egress/anthropic.ts` 的 `mapUpstreamError(payload, httpStatus)` 收下了
 * `httpStatus`，却**只把它写进返回值，不参与分类**：`kind` 完全由 body 里的
 * `error.type` 与 message 正则推出来。
 *
 * 于是只要错误体不是 Anthropic 的 JSON 形状 —— 也就是 CDN / 反代 / L7 网关插进来的
 * 那一层（nginx 的 HTML 502、Cloudflare 的纯文本 `error code: 524`，后者正是本仓库
 * `stream_guard.ts` 文件头亲自记录过的真实形态）—— 分类就落到 `unknown`，
 * `retryable` 落到 `false`。调用方于是**不会退避重试一个纯粹的瞬时故障**。
 *
 * 另外四个出口都拿 `httpStatus` 兜底（`httpStatusKind` / `classifyError` /
 * `code === 500` 分支），只有这一家没有。修法是在 kind 的推导链末尾加一段
 * 「type/message 都没命中时按 httpStatus 归档」。
 */
describe("[暴露缺陷] anthropic 出口的错误分类完全忽略 HTTP 状态码", () => {
  const CLOUDFLARE_524 = "error code: 524";
  const NGINX_502 = "<html><head><title>502 Bad Gateway</title></head></html>";

  it("DEFECT-7a HTTP 503 + 非 JSON 体 → 应当是可重试的 upstreamUnavailable", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(httpResponse(503, NGINX_502, "text/html")));
    expect(error.kind).toBe("upstreamUnavailable");
    expect(error.retryable).toBe(true);
  });

  it("DEFECT-7b Cloudflare 524（纯文本）→ 应当可重试", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(httpResponse(524, CLOUDFLARE_524, "text/plain")));
    expect(error.retryable).toBe(true);
  });

  it("DEFECT-7c HTTP 429 + 非 JSON 体 → 应当是 rateLimited", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(httpResponse(429, "Too Many Requests", "text/plain")));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryable).toBe(true);
  });

  it("DEFECT-7d HTTP 401 + 非 JSON 体 → 应当是 permissionDenied", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(httpResponse(401, "Unauthorized", "text/plain")));
    expect(error.kind).toBe("permissionDenied");
  });

  it("DEFECT-7e 对照：另外四个出口在同一条报文上都分对了", async () => {
    for (const [name, egress] of Object.entries(EGRESSES)) {
      if (name === "anthropic") continue;
      const error = await errorOf(egress.readUpstreamResponse(httpResponse(503, NGINX_502, "text/html")));
      expect({ name, kind: error.kind, retryable: error.retryable })
        .toEqual({ name, kind: "upstreamUnavailable", retryable: true });
    }
  });
});

/**
 * `src/egress/anthropic.ts` 的 `mapUpstreamError` 是一条三元链，顺序是：
 *
 *   type === 'invalid_request_error'   → invalidRequest
 *   … 其它 type …
 *   /context.{0,12}length|too long|…/  → contextLengthExceeded      ← 永远轮不到
 *
 * 而 Anthropic 真实的上下文超长错误**恰好带着** `type:'invalid_request_error'`：
 *
 *   {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"prompt is too long: 214253 tokens > 200000 maximum"}}
 *
 * 于是那条正则是**不可达分支**：这个出口永远产不出 `contextLengthExceeded`。
 * 调用方拿到的是 `invalidRequest`，与「你的请求写错了」不可区分 —— 而这两者的处置
 * 完全相反（前者压缩上下文后重发，后者重发多少次都没用）。这正是 `types.ts` 里
 * 「一天 126 次静默 context_length_exceeded」那条注释描述的故障，只是换了个位置复发。
 *
 * 修法：把 message 正则**前置**到 type 判断之前，或在 invalidRequest 分支内再判一次。
 */
describe("[暴露缺陷] anthropic 出口的 contextLengthExceeded 是不可达分支", () => {
  const REAL_TOO_LONG = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 214253 tokens > 200000 maximum" },
  });

  it("DEFECT-9a HTTP 400 + 真实报文 → 应当是 contextLengthExceeded，实际是 invalidRequest", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(httpResponse(400, REAL_TOO_LONG)));
    expect(error.kind).toBe("contextLengthExceeded");
  });

  it("DEFECT-9b 流内 error 事件里的同一条报文，同样分错", async () => {
    const error = await errorOf(anthropic.readUpstreamResponse(sseResponse([`event: error\ndata: ${REAL_TOO_LONG}`])));
    expect(error.kind).toBe("contextLengthExceeded");
  });

  it("DEFECT-9c 对照：另外三个 JSON 出口在等价报文上都分对了", async () => {
    const cases: readonly [string, IREgress<IRWireBody>, string][] = [
      ["openai_chat", chat, JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "maximum context length is 272000 tokens" } })],
      ["openai_responses", responses, JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "input too long" } })],
      ["gemini_cloudcode", gemini, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count exceeds the maximum" } })],
    ];
    for (const [name, egress, body] of cases) {
      const error = await errorOf(egress.readUpstreamResponse(httpResponse(400, body)));
      expect({ name, kind: error.kind }).toEqual({ name, kind: "contextLengthExceeded" });
    }
  });
});

/**
 * 5xx 是一整段，不是几个点。`gemini_cloudcode` 的分类器逐个枚举
 * `code === 500 || 502 || 503 || 504`，落在这四个之外的 5xx 一律 `unknown` +
 * `retryable:false`；`anthropic` 更彻底，压根不看状态码（见 DEFECT-7）。
 *
 * 落在枚举外的 5xx 不是假想：Cloudflare 的 520/521/522/524 全在这一段，
 * 而本仓库 `stream_guard.ts` 的文件头就记着一次真实的 524。经过任何一层 CDN
 * 或隧道的部署都会撞上它，而撞上的后果是**不退避、不重试**，直接把一个瞬时故障
 * 报成永久失败。
 */
describe("[暴露缺陷] 5xx 应当整段可重试，而不是只认几个特定码", () => {
  for (const status of [520, 522, 524, 529]) {
    it(`DEFECT-8 HTTP ${status}：五个出口都应当是可重试的 upstreamUnavailable`, async () => {
      for (const [name, egress] of Object.entries(EGRESSES)) {
        const error = await errorOf(egress.readUpstreamResponse(
          httpResponse(status, "error code: 524", "text/plain"),
        ));
        expect({ name, status, kind: error.kind, retryable: error.retryable })
          .toEqual({ name, status, kind: "upstreamUnavailable", retryable: true });
      }
    });
  }
});
