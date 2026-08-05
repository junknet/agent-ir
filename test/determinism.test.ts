/**
 * 确定性 —— 入口解码、出口构造、响应折叠三处各一组。
 *
 * 为什么这件事要单独锁：这套架构把「同一个 IR 换个出口出来的对话多了一句网关编的话」
 * 列为反模式（`ARCHITECTURE.md` §8）。而不确定性是同一个病的另一种表现 ——
 * 同一个输入两次跑出不同结果时，「网关编的」那句话只是偶尔出现，
 * 于是它既复现不了，也没人相信它存在。
 *
 * 三处各自的不确定性来源不同，所以断言的对象也不同：
 *   入口 —— Map/Set 的迭代顺序（`requires` 是从 Map 里 collect 出来的）
 *   出口 —— 随机 id、时间戳、进程内缓存（gemini 的 thoughtSignature 就是一个）
 *   折叠 —— 增量拼接的顺序
 *
 * 判据一律是**逐字节相同**，不是「深相等」：深相等放过键序差异，而键序会改变
 * JSON 字节，进而改变上游看到的报文和任何基于 body 做的缓存/签名。
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createAnthropicOutbox } from "../src/egress/anthropic.ts";
import { createOpenAIChatOutbox } from "../src/egress/openai_chat_completions.ts";
import { createOpenAIResponsesOutbox } from "../src/egress/openai_responses.ts";
import { createGeminiCloudCodeOutbox, clearThoughtSignatureCache } from "../src/egress/gemini_cloudcode.ts";
import { createWindsurfOutbox } from "../src/egress/windsurf/index.ts";
import { readClientRequestForProtocol } from "../src/ingress/index.ts";
import { assembleResponse } from "../src/ir/response.ts";
import { superviseUpstreamStream, DEFAULT_STREAM_POLICY } from "../src/ir/stream_guard.ts";
import { IR_PROTOCOLS } from "../src/ir/types.ts";
import type { IROutbox, IREvent, IRProtocol, IRRequest, IRWireBody } from "../src/ir/types.ts";

// ── 工具 ────────────────────────────────────────────────────────────────────

function bodyBytes(body: IRWireBody): string {
  // 统一成十六进制串再比 —— string 与 Uint8Array 两种 wire 用同一把尺子。
  const raw = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 每次调用都造一个全新的出口实例：实例级状态会在这里现形。 */
function freshEgresses(): Readonly<Record<string, IROutbox<IRWireBody>>> {
  return {
    anthropic: createAnthropicOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "claude-test" }),
    openai_chat: createOpenAIChatOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    openai_responses: createOpenAIResponsesOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "gpt-test" }),
    gemini_cloudcode: createGeminiCloudCodeOutbox({
      model: "gemini-test", accessToken: "ya29.t", project: "p",
      sessionId: "1785856733829", requestIdFactory: () => "agent/1785856733829/1785856733829/d/2",
    }),
    windsurf: createWindsurfOutbox({ model: "claude-test-high", apiKey: "devin$h.e.s" }),
  };
}

const OUTBOX_NAMES = Object.keys(freshEgresses());

/** 一条尽量宽的请求：文本 / 思考 / 工具调用 / 工具结果 / 图片 / 采样参数全都有。 */
const RICH_BODY: Readonly<Record<IRProtocol, unknown>> = {
  anthropic_messages: {
    // 32768 而不是 4096：CloudCode 把 thinkingBudget 算进 maxOutputTokens，
    // 上限太低会被它判成 unsatisfiableValue，这组用例就退化成「两次都被拒」——
    // 那样比的是拒绝信息，不是 wire 字节。
    model: "claude-opus-4-8", max_tokens: 32_768, stream: true,
    temperature: 0.7, top_p: 0.9, stop_sequences: ["</done>", "STOP"],
    system: [{ type: "text", text: "You are precise.", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    metadata: { user_id: JSON.stringify({ session_id: "s1", account_uuid: "a1" }) },
    tools: [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } } } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read it", signature: "sig-abc" },
          { type: "text", text: "reading" },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "/a" } },
          { type: "tool_use", id: "call_2", name: "read", input: { path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "alpha" },
          { type: "tool_result", tool_use_id: "call_2", content: "beta", is_error: true },
        ],
      },
    ],
  },
  openai_chat_completions: {
    model: "gpt-5.2", max_completion_tokens: 4096, stream: true, temperature: 0.7, top_p: 0.9,
    reasoning_effort: "high", parallel_tool_calls: true,
    tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    messages: [
      { role: "system", content: "You are precise." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "reading", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "alpha" },
    ],
  },
  openai_responses: {
    model: "gpt-5.2", max_output_tokens: 4096, stream: true, temperature: 0.7,
    instructions: "You are precise.",
    reasoning: { effort: "high", summary: "auto" },
    tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "enc-1" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"/a"}' },
      { type: "function_call_output", call_id: "call_1", output: "alpha" },
    ],
  },
};

function decodeRich(protocol: IRProtocol): IRRequest {
  return readClientRequestForProtocol(protocol, RICH_BODY[protocol], `tr_det_${protocol}`).request;
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、入口解码
// ═══════════════════════════════════════════════════════════════════════════

describe("入口解码：同一份报文连续解两次，产出逐字节相同", () => {
  for (const protocol of IR_PROTOCOLS) {
    it(protocol, () => {
      const first = readClientRequestForProtocol(protocol, RICH_BODY[protocol], "tr_det");
      const second = readClientRequestForProtocol(protocol, RICH_BODY[protocol], "tr_det");
      expect(JSON.stringify(second.request)).toBe(JSON.stringify(first.request));
      expect(JSON.stringify(second.losses)).toBe(JSON.stringify(first.losses));
    });
  }

  it("requires 的顺序稳定 —— 它是从 Map 里 collect 出来的，顺序不能靠运气", () => {
    for (const protocol of IR_PROTOCOLS) {
      const runs = Array.from({ length: 5 }, () =>
        readClientRequestForProtocol(protocol, RICH_BODY[protocol], "tr_det").request.requires
          .map((need) => `${need.capability}:${need.paths.join("|")}`).join(";"));
      expect(new Set(runs).size).toBe(1);
    }
  });

  it("解码不修改入参报文 —— 同一个对象连解十次都是同一个结果", () => {
    const body = structuredClone(RICH_BODY.anthropic_messages) as Record<string, unknown>;
    const snapshot = JSON.stringify(body);
    const outputs = Array.from({ length: 10 }, () =>
      JSON.stringify(readClientRequestForProtocol("anthropic_messages", body, "tr_det").request));
    expect(new Set(outputs).size).toBe(1);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("traceId 是唯一会变的东西 —— 除它以外两次解码完全一致", () => {
    const a = readClientRequestForProtocol("anthropic_messages", RICH_BODY.anthropic_messages, "tr_A").request;
    const b = readClientRequestForProtocol("anthropic_messages", RICH_BODY.anthropic_messages, "tr_B").request;
    expect(JSON.stringify({ ...a, traceId: "" })).toBe(JSON.stringify({ ...b, traceId: "" }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 二、出口构造
// ═══════════════════════════════════════════════════════════════════════════

describe("出口构造：同一个 IR 连续构造两次，wire 逐字节相同", () => {
  for (const name of OUTBOX_NAMES) {
    it(`${name}：同一个实例`, async () => {
      const request = decodeRich("anthropic_messages");
      const outbox = freshEgresses()[name]!;
      clearThoughtSignatureCache();
      const first = await outbox.writeOutboxRequest(request);
      const second = await outbox.writeOutboxRequest(request);
      expect(first.ok).toBe(second.ok);
      if (!first.ok || !second.ok) {
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        return;
      }
      expect(bodyBytes(second.wire.body)).toBe(bodyBytes(first.wire.body));
      expect(second.wire.url).toBe(first.wire.url);
      expect(JSON.stringify(second.wire.headers)).toBe(JSON.stringify(first.wire.headers));
      expect(JSON.stringify(second.losses)).toBe(JSON.stringify(first.losses));
    });

    it(`${name}：换一个新实例（相同 options）结果也一样 —— 出口不许攒实例级状态`, async () => {
      const request = decodeRich("anthropic_messages");
      clearThoughtSignatureCache();
      const first = await freshEgresses()[name]!.writeOutboxRequest(request);
      clearThoughtSignatureCache();
      const second = await freshEgresses()[name]!.writeOutboxRequest(request);
      expect(first.ok).toBe(second.ok);
      if (first.ok && second.ok) {
        expect(bodyBytes(second.wire.body)).toBe(bodyBytes(first.wire.body));
      }
    });
  }

  it("构造不修改入参 IR —— 构造十次之后 IR 与出发时逐字节相同", async () => {
    const request = decodeRich("anthropic_messages");
    const snapshot = JSON.stringify(request);
    for (const name of OUTBOX_NAMES) {
      clearThoughtSignatureCache();
      const outbox = freshEgresses()[name]!;
      await outbox.writeOutboxRequest(request);
      await outbox.writeOutboxRequest(request);
      expect(JSON.stringify(request)).toBe(snapshot);
    }
  });

  it("三个入口解出的同一段对话，在同一个出口上编出同一份 wire", async () => {
    /**
     * 入口无关性的**字节级**形式。
     *
     * 只能拿 conversation 说事：三个入口的 L1 默认值本来就不同（Chat 的
     * `reasoning.display` 缺省是 `summarized`，另外两家是 `full`），那是各协议
     * 自己的语义，不是漂移。所以这里把 intent 统一成同一份再比 ——
     * 剩下的差异就只可能来自 conversation 的解码，而那正是要锁的东西。
     */
    const simple: Readonly<Record<IRProtocol, unknown>> = {
      anthropic_messages: { model: "m", max_tokens: 256, messages: [{ role: "user", content: "ping" }] },
      openai_chat_completions: { model: "m", max_completion_tokens: 256, messages: [{ role: "user", content: "ping" }] },
      openai_responses: { model: "m", max_output_tokens: 256, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }] },
    };
    const reference = readClientRequestForProtocol("anthropic_messages", simple.anthropic_messages, "tr_same").request;

    for (const name of OUTBOX_NAMES) {
      const built: string[] = [];
      for (const protocol of IR_PROTOCOLS) {
        const { request } = readClientRequestForProtocol(protocol, simple[protocol], "tr_same");
        // model 与 traceId 也统一：前者是客户端说的名字（出口不用它），
        // 后者被 windsurf 拌进 request id，两者都与「对话解得对不对」无关。
        const aligned: IRRequest = {
          ...request, traceId: reference.traceId, model: reference.model, intent: reference.intent,
        };
        clearThoughtSignatureCache();
        const result = await freshEgresses()[name]!.writeOutboxRequest(aligned);
        expect({ name, protocol, ok: result.ok }).toEqual({ name, protocol, ok: true });
        if (result.ok) built.push(bodyBytes(result.wire.body));
      }
      expect({ name, distinct: new Set(built).size }).toEqual({ name, distinct: 1 });
    }
  });
});

describe("出口构造：确定性的边界 —— 进程内缓存是唯一的外部输入", () => {
  /**
   * gemini 的 `thoughtSignature` 缓存是**进程内全局状态**：上一轮 lift 记住的签名
   * 会在下一轮 lower 时被回填进 wire。这是有意的设计（IR 没有承载它的位置），
   * 但它意味着「同一个 IR」并不足以决定 wire —— 还要加上进程历史。
   *
   * 这条测试不是在反对那个设计，是把它的**边界**钉住：清了缓存就必须确定，
   * 没清就允许不同。任何人以后想在别的出口加类似缓存，会先撞到这条。
   */
  it("清过缓存之后，gemini 的构造是确定的", async () => {
    const request = decodeRich("anthropic_messages");
    clearThoughtSignatureCache();
    const first = await freshEgresses().gemini_cloudcode!.writeOutboxRequest(request);
    clearThoughtSignatureCache();
    const second = await freshEgresses().gemini_cloudcode!.writeOutboxRequest(request);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(bodyBytes(second.wire.body)).toBe(bodyBytes(first.wire.body));
  });

  it("另外四个出口没有任何进程内状态：不清缓存也照样逐字节相同", async () => {
    const request = decodeRich("anthropic_messages");
    for (const name of OUTBOX_NAMES) {
      if (name === "gemini_cloudcode") continue;
      const first = await freshEgresses()[name]!.writeOutboxRequest(request);
      const second = await freshEgresses()[name]!.writeOutboxRequest(request);
      if (first.ok && second.ok) {
        expect({ name, same: bodyBytes(second.wire.body) === bodyBytes(first.wire.body) })
          .toEqual({ name, same: true });
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 三、响应折叠
// ═══════════════════════════════════════════════════════════════════════════

const FOLD_EVENTS: readonly IREvent[] = [
  { kind: "messageStart", model: "claude-opus-4-8" },
  { kind: "partStart", index: 0, part: { kind: "thinking", text: "" } },
  { kind: "partDelta", index: 0, delta: { kind: "thinking", text: "weigh " } },
  { kind: "partDelta", index: 0, delta: { kind: "thinking", text: "options" } },
  { kind: "partDelta", index: 0, delta: { kind: "thinkingSignature", signature: "sig-1" } },
  { kind: "partEnd", index: 0 },
  { kind: "partStart", index: 1, part: { kind: "text", text: "" } },
  { kind: "partDelta", index: 1, delta: { kind: "text", text: "PO" } },
  { kind: "partDelta", index: 1, delta: { kind: "text", text: "NG" } },
  { kind: "partEnd", index: 1 },
  { kind: "partStart", index: 2, part: { kind: "toolCall", call: { id: "call_1", toolRef: { group: null, name: "read" }, input: { kind: "json", value: {} } } } },
  { kind: "partDelta", index: 2, delta: { kind: "toolInputJson", json: '{"path":' } },
  { kind: "partDelta", index: 2, delta: { kind: "toolInputJson", json: '"/a"}' } },
  { kind: "partEnd", index: 2 },
  { kind: "loss", loss: { stage: "outbox", outbox: "anthropic", path: "$.x", kind: "dropped", detail: "d" } },
  { kind: "unhandled", rawType: "future_event", raw: { a: 1 } },
  { kind: "usage", usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 800 } },
  { kind: "messageStop", reason: "toolUse" },
];

function replay(events: readonly IREvent[]): AsyncIterable<IREvent> {
  return (async function* () { yield* events; })();
}

describe("响应折叠：同一串事件折两次，产出逐字节相同", () => {
  it("assembleResponse 是纯函数", async () => {
    const first = await assembleResponse(replay(FOLD_EVENTS), "fallback");
    const second = await assembleResponse(replay(FOLD_EVENTS), "fallback");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("连折十次都一样 —— 增量拼接不许带上一次的残留", async () => {
    const outputs: string[] = [];
    for (let i = 0; i < 10; i++) {
      outputs.push(JSON.stringify(await assembleResponse(replay(FOLD_EVENTS), "fallback")));
    }
    expect(new Set(outputs).size).toBe(1);
  });

  it("折叠不消耗也不修改事件对象 —— 同一批对象可以反复折", async () => {
    const snapshot = JSON.stringify(FOLD_EVENTS);
    await assembleResponse(replay(FOLD_EVENTS), "fallback");
    await assembleResponse(replay(FOLD_EVENTS), "fallback");
    expect(JSON.stringify(FOLD_EVENTS)).toBe(snapshot);
  });

  it("事件到达的分片粒度不影响结果：一次给完与逐条给完全一样", async () => {
    const eager = await assembleResponse(replay(FOLD_EVENTS), "fallback");
    const lazy = await assembleResponse((async function* () {
      for (const event of FOLD_EVENTS) { await Promise.resolve(); yield event; }
    })(), "fallback");
    expect(JSON.stringify(lazy)).toBe(JSON.stringify(eager));
  });

  it("穿过流守卫再折叠，结果不变 —— committed/heartbeat 不进响应文档", async () => {
    const direct = await assembleResponse(replay(FOLD_EVENTS), "fallback");
    const guarded = await assembleResponse(
      superviseUpstreamStream(replay(FOLD_EVENTS), DEFAULT_STREAM_POLICY),
      "fallback",
    );
    expect(JSON.stringify(guarded)).toBe(JSON.stringify(direct));
  });

  it("守卫注入的事件本身也是确定的：同一串事件跑两次注入位置相同", async () => {
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out: string[] = [];
      for await (const event of superviseUpstreamStream(replay(FOLD_EVENTS), DEFAULT_STREAM_POLICY)) {
        out.push(event.kind);
      }
      runs.push(out.join(","));
    }
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]!.split(",").filter((kind) => kind === "committed")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 语料上的确定性
// ═══════════════════════════════════════════════════════════════════════════

const CORPUS_PATH = new URL("../.corpus/requests.ndjson", import.meta.url).pathname;

interface CorpusEntry { readonly traceId: string; readonly protocol: IRProtocol; readonly body: string }

const corpus: CorpusEntry[] = existsSync(CORPUS_PATH)
  ? readFileSync(CORPUS_PATH, "utf-8").split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusEntry)
  : [];

describe("语料上的确定性", () => {
  it.skipIf(corpus.length === 0)("每条真实请求解码两次都逐字节相同", () => {
    for (const entry of corpus) {
      const body: unknown = JSON.parse(entry.body);
      const first = readClientRequestForProtocol(entry.protocol, body, entry.traceId);
      const second = readClientRequestForProtocol(entry.protocol, body, entry.traceId);
      expect(JSON.stringify(second.request).length).toBe(JSON.stringify(first.request).length);
      expect(JSON.stringify(second.losses)).toBe(JSON.stringify(first.losses));
    }
  }, 60_000);

  it.skipIf(corpus.length === 0)("每条真实请求在每个出口上构造两次都逐字节相同", async () => {
    // 取前 60 条即可：确定性是结构性质，跑满 807 × 5 × 2 只是把同一件事重复更多遍。
    for (const entry of corpus.slice(0, 60)) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const name of OUTBOX_NAMES) {
        clearThoughtSignatureCache();
        const first = await freshEgresses()[name]!.writeOutboxRequest(request);
        clearThoughtSignatureCache();
        const second = await freshEgresses()[name]!.writeOutboxRequest(request);
        expect({ name, trace: entry.traceId, ok: second.ok }).toEqual({ name, trace: entry.traceId, ok: first.ok });
        if (first.ok && second.ok) {
          expect({ name, trace: entry.traceId, same: bodyBytes(second.wire.body) === bodyBytes(first.wire.body) })
            .toEqual({ name, trace: entry.traceId, same: true });
        }
      }
    }
  }, 120_000);
});
