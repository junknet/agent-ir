/**
 * Windsurf via Connect + protobuf 出口。
 *
 * 与前四个出口的测试有一处根本不同：**报文不是手写的字面量，是真的 protobuf 字节**。
 * 每一帧都由 `windsurf_exa.fds.pb` 里的真实 descriptor 编出来，再套上真实的 Connect
 * 信封（`[flag][len:4BE][payload]`）。手敲一串十六进制既编不对也读不懂，更重要的是
 * 手敲的字节证明不了「本地 FDS 与上游 schema 对得上」。
 *
 * 报文**形状**取自生产实证：
 *   - `packages/windsurf_protocol/test/messages.test.ts` —— deltaText / 分片 deltaToolCalls /
 *     跨帧累积的 usage / stopReason=10 全部照抄那里的真实序列；
 *   - `packages/relay_core/test/{messages_failure_policy,upstream_application_error}.test.ts`
 *     —— 尾帧 `{"code":"permission_denied","message":"an internal error occurred"}` 是那两处
 *     用例里的原文。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CHISEL_PROFILE, createWindsurfOutbox, WINDSURF_OBSERVED_IDENTITY_LINE,
} from "../src/egress/windsurf/index.ts";
import { createAnthropicOutbox } from "../src/egress/anthropic.ts";
import {
  CONNECT_FRAME_HEADER_BYTES, createDeframeState, deframe, enframe, parseConnectTrailer,
} from "../src/egress/windsurf/connect_frame.ts";
import { getSharedWindsurfSchema, WINDSURF_TYPES } from "../src/egress/windsurf/schema.ts";
import { normalizeConnectCode } from "../src/egress/windsurf/errors.ts";
import { checkOutboxSupport } from "../src/ir/admission.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { clientValue, defaultValue } from "../src/ir/types.ts";
import type {
  IREvent, IRIntent, IRPart, IRRequest, IRToolset, IRTurn, OutboxRequestBuildResult,
} from "../src/ir/types.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const schema = getSharedWindsurfSchema();

const outbox = createWindsurfOutbox({
  model: "claude-opus-4-8-high",
  apiKey: "devin-session-token$h.eyJzZXNzaW9uX2lkIjoicyJ9.sig",
});

const EMPTY_TOOLSET: IRToolset = {
  tools: [],
  groups: [],
  choice: defaultValue({ kind: "auto" }),
  parallel: defaultValue(true),
};

function intent(overrides: Partial<IRIntent> = {}): IRIntent {
  return {
    reasoning: defaultValue({ mode: "adaptive", display: "summarized" }),
    outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"),
    sampling: {},
    stopping: {},
    contextEdits: [],
    stream: clientValue(true),
    identity: {},
    ...overrides,
  };
}

function request(parts: {
  system?: readonly IRPart[];
  turns: readonly IRTurn[];
  toolset?: IRToolset;
  intent?: IRIntent;
  traceId?: string;
}): IRRequest {
  const base = {
    traceId: parts.traceId ?? "tr_windsurf",
    protocol: "anthropic_messages" as const,
    model: "claude-opus-4-6",
    conversation: {
      system: parts.system ?? [],
      turns: parts.turns,
      toolset: parts.toolset ?? EMPTY_TOOLSET,
    },
    intent: parts.intent ?? intent(),
  };
  return { ...base, requires: deriveCapabilityNeeds(base) };
}

/** 最小可通过的请求：带 system（有工具时上游要求非空）+ 一个 user 回合。 */
function simpleRequest(overrides: Partial<Parameters<typeof request>[0]> = {}): IRRequest {
  return request({
    system: [{ kind: "text", text: "You are a coding assistant." }],
    turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    ...overrides,
  });
}

function expectOk(result: OutboxRequestBuildResult<Uint8Array>): Extract<OutboxRequestBuildResult<Uint8Array>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok build, got problems: ${JSON.stringify(result.problems)}`);
  }
  return result;
}

/** 解回出站的 GetChatMessageRequest —— 断言的是真字节，不是构造它的那个对象。 */
function decodeWire(result: OutboxRequestBuildResult<Uint8Array>): Record<string, any> {
  const wire = expectOk(result).wire;
  expect(wire.body).toBeInstanceOf(Uint8Array);
  const framed = wire.body as Uint8Array;
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  expect(view.getUint8(0)).toBe(0);
  const length = view.getUint32(1, false);
  expect(framed.byteLength).toBe(CONNECT_FRAME_HEADER_BYTES + length);
  return fromBinary(
    schema.requestDesc,
    framed.slice(CONNECT_FRAME_HEADER_BYTES, CONNECT_FRAME_HEADER_BYTES + length),
  ) as unknown as Record<string, any>;
}

// ── 响应报文：真 protobuf + 真 Connect 信封 ─────────────────────────────────

function dataFrame(init: Record<string, unknown>): Uint8Array {
  return enframe(toBinary(schema.responseDesc, create(schema.responseDesc, init as never)));
}

function endFrame(trailer: Record<string, unknown>): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(trailer));
  const framed = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(framed.buffer);
  view.setUint8(0, 0b10);
  view.setUint32(1, payload.length, false);
  framed.set(payload, CONNECT_FRAME_HEADER_BYTES);
  return framed;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** 把字节按给定切点拆成多个 chunk 下发，用来逼出跨 chunk 的半帧。 */
function connectResponse(bytes: Uint8Array, chunkSizes?: readonly number[]): Response {
  const chunks: Uint8Array[] = [];
  if (chunkSizes === undefined) {
    chunks.push(bytes);
  } else {
    let offset = 0;
    for (const size of chunkSizes) {
      chunks.push(bytes.slice(offset, offset + size));
      offset += size;
    }
    if (offset < bytes.length) chunks.push(bytes.slice(offset));
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) if (chunk.length > 0) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/connect+proto" },
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

/**
 * protobuf 的「没设」在解出来的对象上是**类型相关的零值**，不是 `undefined`：
 * 标量是 `""` / `0` / `0n` / `false`，list 是 `[]`，bytes 是**空 `Uint8Array`**，
 * 只有 message 字段才真的是 `undefined`。
 *
 * 拿 `?? ` 或 `!== ""` 判空会在 bytes 和 list 上给出假阳性 —— 这正是
 * 「geminiThoughtSignature 每条都非空」那个错误结论的成因。判空只走这一个函数。
 */
function isEmptyWireValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (value instanceof Uint8Array) return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "number") return value === 0;
  if (typeof value === "bigint") return value === 0n;
  if (typeof value === "boolean") return !value;
  return false;
}

function pickConfiguration(configuration: Record<string, any>): Record<string, unknown> {
  return {
    numCompletions: configuration.numCompletions,
    maxNewlines: configuration.maxNewlines,
    temperature: configuration.temperature,
    topK: configuration.topK,
    topP: configuration.topP,
    seed: configuration.seed,
    stopPatterns: configuration.stopPatterns,
    serviceTier: configuration.serviceTier,
  };
}

function pickMetadata(metadata: Record<string, any>): Record<string, unknown> {
  return {
    ideName: metadata.ideName,
    extensionName: metadata.extensionName,
    extensionVersion: metadata.extensionVersion,
    ideVersion: metadata.ideVersion,
    locale: metadata.locale,
    os: metadata.os,
    apiKey: metadata.apiKey,
  };
}

// ── Connect 帧切分 ──────────────────────────────────────────────────────────

describe("Connect 信封帧", () => {
  it("enframe 头部是 flag=0 + 4 字节大端长度", () => {
    const framed = enframe(new Uint8Array([1, 2, 3]));
    expect(framed.length).toBe(8);
    expect(framed[0]).toBe(0);
    expect([...framed.slice(1, 5)]).toEqual([0, 0, 0, 3]);
    expect([...framed.slice(5)]).toEqual([1, 2, 3]);
  });

  it("跨 chunk 的半帧被缓冲到完整才产出", async () => {
    const framed = enframe(new Uint8Array([10, 20, 30, 40]));
    // 逐字节喂：帧头都不完整，任何「读到就解」的实现都会在这里错位。
    const source = (async function* () {
      for (const byte of framed) yield new Uint8Array([byte]);
    })();
    const state = createDeframeState();
    const frames = [];
    for await (const frame of deframe(source, state)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect([...(frames[0]?.payload ?? [])]).toEqual([10, 20, 30, 40]);
    expect(state.residualBytes).toBe(0);
  });

  it("一个 chunk 里的多帧全部切出，结束帧的 flag&2 可辨认", async () => {
    const bytes = concat([dataFrame({ deltaText: "a" }), endFrame({})]);
    const source = (async function* () { yield bytes; })();
    const frames = [];
    for await (const frame of deframe(source)) frames.push(frame);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.flag).toBe(0);
    expect((frames[1]?.flag ?? 0) & 0b10).toBe(0b10);
  });

  it("流在一帧中间断掉时把残留字节数留给调用方判死", async () => {
    const framed = dataFrame({ deltaText: "hello" });
    const source = (async function* () { yield framed.slice(0, framed.length - 2); })();
    const state = createDeframeState();
    const frames = [];
    for await (const frame of deframe(source, state)) frames.push(frame);
    expect(frames).toHaveLength(0);
    expect(state.residualBytes).toBe(framed.length - 2);
  });

  it("尾帧解析：空 payload 是干净收尾，非 JSON 必须显式判失败", () => {
    expect(parseConnectTrailer(new Uint8Array(0))).toEqual({ ok: true, trailer: {} });
    const good = parseConnectTrailer(new TextEncoder().encode('{"error":{"code":"permission_denied"}}'));
    expect(good.ok).toBe(true);
    const bad = parseConnectTrailer(new TextEncoder().encode("not json"));
    expect(bad.ok).toBe(false);
  });
});

// ── schema 反射 ─────────────────────────────────────────────────────────────

describe("FileDescriptorSet 运行时反射", () => {
  it("按全限定名取到本出口用到的全部类型", () => {
    for (const typeName of Object.values(WINDSURF_TYPES)) {
      expect(schema.message(typeName).typeName).toBe(typeName);
    }
  });

  it("子消息 descriptor 从父字段上取，而不是按名字二次查表", () => {
    expect(schema.childOf(schema.requestDesc, "chatMessagePrompts").typeName)
      .toBe("exa.chat_pb.ChatMessagePrompt");
    expect(schema.childOf(schema.requestDesc, "configuration").typeName)
      .toBe("exa.codeium_common_pb.CompletionConfiguration");
    expect(() => schema.childOf(schema.requestDesc, "nope")).toThrow(/has no field/u);
    expect(() => schema.childOf(schema.requestDesc, "prompt")).toThrow(/not a message field/u);
  });
});

// ── 能力声明 ────────────────────────────────────────────────────────────────

describe("能力声明", () => {
  it("supports 与 lossy 不重叠，且合起来不含四项已知不可承载的能力", () => {
    const { supports, lossy } = outbox.profile;
    for (const capability of supports) expect(lossy.has(capability)).toBe(false);
    for (const capability of ["document", "toolBuiltin", "toolChoiceSpecific", "structuredOutput"] as const) {
      expect(supports.has(capability)).toBe(false);
      expect(lossy.has(capability)).toBe(false);
    }
  });

  it("thinking 进 supports —— 抓包双向实证（39/135 回合出站、850/2107 帧回读）", () => {
    expect(outbox.profile.supports.has("thinking")).toBe(true);
    expect(outbox.profile.lossy.has("thinking")).toBe(false);
  });

  it("证据仍不够的四条留在 lossy，不为了好看升级", () => {
    // thinkingSignature：双向都有实证但 IR 装不下 signature_type（抓包 2/135、2/2107）。
    expect(outbox.profile.lossy.has("thinkingSignature")).toBe(true);
    // toolGroup：抓包 253 个工具定义 server_name 全空，分组语义零实证，只能拍进名字。
    expect(outbox.profile.lossy.has("toolGroup")).toBe(true);
    // toolResultImage：抓包 23 个 source=4 回合全部 0 张图，关联性零实证。
    expect(outbox.profile.lossy.has("toolResultImage")).toBe(true);
    // cacheBreakpoint：抓包 12/12 条两个 cache_options 字段都没设。
    expect(outbox.profile.lossy.has("cacheBreakpoint")).toBe(true);
    for (const capability of ["thinkingSignature", "toolGroup", "toolResultImage", "cacheBreakpoint"] as const) {
      expect(outbox.profile.supports.has(capability)).toBe(false);
    }
  });

  it("准入把结构化输出指到精确路径而不是笼统报错", () => {
    const irRequest = simpleRequest({
      intent: intent({
        outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }),
      }),
    });
    const check = checkOutboxSupport(irRequest, outbox.profile);
    expect(check.admitted).toBe(false);
    expect(check.unsupported.map((need) => need.capability)).toContain("structuredOutput");
    expect(check.unsupported[0]?.paths).toContain("$.intent.outputFormat");
  });
});

// ── 出站请求构造 ────────────────────────────────────────────────────────────

describe("writeOutboxRequest 构造真实 GetChatMessage", () => {
  it("system 进顶层 prompt，回合进 chat_message_prompts，模型进 chat_model_uid", async () => {
    const decoded = decodeWire(await outbox.writeOutboxRequest(simpleRequest()));
    // 默认身份策略的后置条件在这里也成立：客户端的 system 原样在，身份行被补在最前面。
    // 想要逐字节透传的调用方传 systemIdentity={kind:'passthrough'}（见下面那组用例）。
    expect(decoded.prompt).toBe(`${WINDSURF_OBSERVED_IDENTITY_LINE}\n\nYou are a coding assistant.`);
    expect(decoded.chatModelUid).toBe("claude-opus-4-8-high");
    expect(decoded.requestType).toBe(5);
    expect(decoded.plannerMode).toBe(1);
    expect(decoded.chatMessagePrompts).toHaveLength(1);
    expect(decoded.chatMessagePrompts[0]).toMatchObject({ source: 1, prompt: "hi" });
    expect(decoded.metadata.apiKey).toBe("devin-session-token$h.eyJzZXNzaW9uX2lkIjoicyJ9.sig");
    expect(decoded.trajectoryReference).toMatchObject({ trajectoryType: 4, stepType: 14 });
  });

  it("body 保留原始 Connect 字节，头里给 Connect 的两个必需头", async () => {
    const wire = expectOk(await outbox.writeOutboxRequest(simpleRequest())).wire;
    expect(wire.headers["content-type"]).toBe("application/connect+proto");
    expect(wire.headers["connect-protocol-version"]).toBe("1");
    expect(wire.headers.authorization).toStartWith("Basic devin-session-token$");
    expect(wire.body).toBeInstanceOf(Uint8Array);
    expect(wire.url).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage");
    // 首字节是 Connect 数据帧标志；直接交给 fetch 时不会经过文本重编码。
    expect((wire.body as Uint8Array)[0]).toBe(0);
    const request = new Request(wire.url, {
      method: wire.method,
      headers: wire.headers,
      body: new Uint8Array(wire.body),
    });
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array(wire.body));
  });

  it("同一条 IR 构造两次得到逐字节相同的 body", async () => {
    const irRequest = simpleRequest();
    const first = expectOk(await outbox.writeOutboxRequest(irRequest)).wire.body as Uint8Array;
    const second = expectOk(await outbox.writeOutboxRequest(irRequest)).wire.body as Uint8Array;
    expect(second).toEqual(first);
    // traceId 变了才该变：id 是从 traceId 派生的，不是随机的。
    const other = expectOk(await outbox.writeOutboxRequest(
      simpleRequest({ traceId: "tr_other" }),
    )).wire.body as Uint8Array;
    expect(other).not.toEqual(first);
  });

  it("工具往返：assistant 的 toolCall 进 toolCalls，结果各自成一条 source=4 的 prompt", async () => {
    const decoded = decodeWire(await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [
        { role: "user", parts: [{ kind: "text", text: "create hello.txt" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "writing" },
            {
              kind: "toolCall",
              call: {
                id: "toolu_9",
                toolRef: { group: null, name: "Write" },
                input: { kind: "json", value: { path: "hello.txt", content: "OK" } },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [{
            kind: "toolResult",
            result: { callId: "toolu_9", status: "ok", parts: [{ kind: "text", text: "wrote 2 bytes" }] },
          }],
        },
      ],
      toolset: {
        ...EMPTY_TOOLSET,
        tools: [{
          kind: "function", ref: { group: null, name: "Write" },
          description: "write a file", schema: { type: "object" },
        }],
      },
    })));

    expect(decoded.chatMessagePrompts.map((one: any) => one.source)).toEqual([1, 2, 4]);
    expect(decoded.chatMessagePrompts[1].toolCalls).toHaveLength(1);
    expect(decoded.chatMessagePrompts[1].toolCalls[0]).toMatchObject({ id: "toolu_9", name: "Write" });
    expect(JSON.parse(decoded.chatMessagePrompts[1].toolCalls[0].argumentsJson))
      .toEqual({ path: "hello.txt", content: "OK" });
    expect(decoded.chatMessagePrompts[2]).toMatchObject({ toolCallId: "toolu_9", prompt: "wrote 2 bytes" });
    expect(decoded.tools).toHaveLength(1);
    expect(decoded.tools[0].name).toBe("Write");
  });

  it("错误的工具结果打上 tool_result_is_error", async () => {
    const decoded = decodeWire(await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [
        {
          role: "assistant",
          parts: [{
            kind: "toolCall",
            call: { id: "t1", toolRef: { group: null, name: "Bash" }, input: { kind: "json", value: {} } },
          }],
        },
        {
          role: "user",
          parts: [{
            kind: "toolResult",
            result: { callId: "t1", status: "error", parts: [{ kind: "text", text: "boom" }] },
          }],
        },
      ],
    })));
    expect(decoded.chatMessagePrompts.map((one: any) => [one.source, one.toolResultIsError]))
      .toEqual([[2, false], [4, true]]);
  });

  it("图片进 ImageData，且不往 prompt 里注入任何占位文案", async () => {
    const decoded = decodeWire(await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "user",
        parts: [
          { kind: "image", media: { source: { kind: "base64", data: "AA==" }, mediaType: "image/png" } },
          { kind: "text", text: "inspect it" },
        ],
      }],
    })));
    expect(decoded.chatMessagePrompts).toHaveLength(1);
    // 生产实现会插一句 `[Image 1: inline-image-1]`；那是发明内容，本出口不做。
    expect(decoded.chatMessagePrompts[0].prompt).toBe("inspect it");
    expect(decoded.chatMessagePrompts[0].images).toEqual([
      expect.objectContaining({ base64Data: "AA==", mimeType: "image/png" }),
    ]);
  });

  it("缓存断点落到 prompt_cache_options / system_prompt_cache_options 的 EPHEMERAL", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys", cacheBreakpoint: { scope: "ephemeral" } }],
      turns: [{
        role: "user",
        parts: [{ kind: "text", text: "hi", cacheBreakpoint: { scope: "ephemeral", ttlSeconds: 3600 } }],
      }],
    }));
    const decoded = decodeWire(result);
    expect(decoded.systemPromptCacheOptions).toMatchObject({ type: 1 });
    expect(decoded.chatMessagePrompts[0].promptCacheOptions).toMatchObject({ type: 1 });
    // TTL 没有承载字段，必须留痕。
    expect(expectOk(result).losses.some((loss) => loss.path.endsWith("cacheBreakpoint.ttlSeconds")))
      .toBe(true);
  });

  it("思考写进 thinking 且不再记 loss；只有签名因为丢了 signature_type 才留痕", async () => {
    const withSignature = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "assistant",
        parts: [
          { kind: "thinking", text: "let me think", signature: "sig-abc" },
          { kind: "text", text: "done" },
        ],
      }],
    }));
    expect(decodeWire(withSignature).chatMessagePrompts[0]).toMatchObject({
      thinking: "let me think", signature: "sig-abc", prompt: "done",
    });
    const signatureLoss = expectOk(withSignature).losses.find(
      (loss) => loss.path === "$.conversation.turns[0]" && loss.detail.includes("signature_type"),
    );
    expect(signatureLoss?.kind).toBe("degraded");
    // 损的是家族标签，不是「上游会不会消费思考」——后者已被抓包证伪。
    expect(signatureLoss?.detail).toContain("openai");

    // 没有签名的纯思考回合：wire 照常带 thinking，一条回合级 loss 都不记。
    const bare = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "assistant",
        parts: [{ kind: "thinking", text: "just thinking" }, { kind: "text", text: "done" }],
      }],
    }));
    expect(decodeWire(bare).chatMessagePrompts[0]).toMatchObject({
      thinking: "just thinking", signature: "", prompt: "done",
    });
    expect(expectOk(bare).losses.filter((loss) => loss.path === "$.conversation.turns[0]")).toEqual([]);
  });

  it("客户端给了采样参数就用客户端的，没给才由出口命名并留痕", async () => {
    const bare = await outbox.writeOutboxRequest(simpleRequest());
    const bareDecoded = decodeWire(bare);
    expect(bareDecoded.configuration).toMatchObject({ temperature: 1, topK: 40n, topP: 0.95 });
    const substitution = expectOk(bare).losses.find((loss) => loss.path === "$.intent");
    expect(substitution?.kind).toBe("substituted");
    expect(substitution?.detail).toContain("temperature");
    expect(substitution?.detail).toContain("max_newlines");

    const explicit = await outbox.writeOutboxRequest(simpleRequest({
      intent: intent({
        sampling: { temperature: clientValue(0.3), topP: clientValue(0.5), topK: clientValue(7) },
        stopping: { maxOutputTokens: clientValue(4096), stopSequences: clientValue(["</done>"]) },
      }),
    }));
    const explicitDecoded = decodeWire(explicit);
    expect(explicitDecoded.configuration).toMatchObject({
      temperature: 0.3, topP: 0.5, topK: 7n, maxTokens: 4096n,
    });
    expect(explicitDecoded.configuration.stopPatterns).toEqual(["</done>"]);
    // 采样四项都给了，命名清单里就只剩没有 IR 对应物的 max_newlines。
    const named = expectOk(explicit).losses.find((loss) => loss.path === "$.intent");
    expect(named?.detail).not.toContain("temperature,");
    expect(named?.detail).toContain("max_newlines");
  });

  it("关闭并行工具调用走 disable_parallel_tool_calls", async () => {
    const decoded = decodeWire(await outbox.writeOutboxRequest(simpleRequest({
      toolset: { ...EMPTY_TOOLSET, parallel: clientValue(false) },
    })));
    expect(decoded.disableParallelToolCalls).toBe(true);
  });

  it("effort 记成 substituted 并说明它是靠模型 id 表达的", async () => {
    const result = await outbox.writeOutboxRequest(simpleRequest({
      intent: intent({ reasoning: clientValue({ mode: "enabled", display: "summarized", effort: "high" }) }),
    }));
    const loss = expectOk(result).losses.find((one) => one.path === "$.intent.reasoning.effort");
    expect(loss?.kind).toBe("substituted");
    expect(loss?.detail).toContain("claude-opus-4-8-high");
  });
});

// ── 拒绝 ────────────────────────────────────────────────────────────────────

describe("writeOutboxRequest 的拒绝条件", () => {
  it("悬空的工具调用带精确路径拒绝", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "assistant",
        parts: [{
          kind: "toolCall",
          call: { id: "t_dangling", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: {} } },
        }],
      }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({
      kind: "danglingToolCall",
      path: "$.conversation.turns[0].parts[0]",
    })]);
  });

  it("孤儿工具结果带精确路径拒绝", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "user",
        parts: [{
          kind: "toolResult",
          result: { callId: "t_orphan", status: "ok", parts: [{ kind: "text", text: "x" }] },
        }],
      }],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({
      kind: "orphanToolResult",
      path: "$.conversation.turns[0].parts[0]",
    })]);
  });

  it("带工具却没有 system 时按生产实证拒绝", async () => {
    const result = await outbox.writeOutboxRequest(request({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      toolset: {
        ...EMPTY_TOOLSET,
        tools: [{ kind: "function", ref: { group: null, name: "Read" }, description: "d", schema: {} }],
      },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.conversation.system",
    })]);
  });

  it("一次收齐全部构造问题，而不是遇到第一个就返回", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [
        { kind: "text", text: "sys" },
        { kind: "image", media: { source: { kind: "base64", data: "AA==" }, mediaType: "image/png" } },
      ],
      turns: [
        {
          role: "user",
          parts: [
            { kind: "document", media: { source: { kind: "base64", data: "JVBE" }, mediaType: "application/pdf" } },
            {
              kind: "toolResult",
              result: { callId: "orphan_1", status: "ok", parts: [{ kind: "text", text: "x" }] },
            },
          ],
        },
        {
          role: "assistant",
          parts: [{
            kind: "toolCall",
            call: { id: "dangling_1", toolRef: { group: null, name: "Read" }, input: { kind: "json", value: {} } },
          }],
        },
      ],
      toolset: {
        ...EMPTY_TOOLSET,
        tools: [{ kind: "builtin", ref: { group: null, name: "computer" }, builtin: "computer_20250124" }],
        choice: clientValue({ kind: "specific", ref: { group: null, name: "Read" } }),
      },
      intent: intent({ outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }) }),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byKind = result.problems.map((problem) => `${problem.kind}@${problem.path}`).sort();
    expect(byKind).toEqual([
      "danglingToolCall@$.conversation.turns[1].parts[0]",
      "orphanToolResult@$.conversation.turns[0].parts[1]",
      "unrepresentablePart@$.conversation.system[1]",
      "unrepresentablePart@$.conversation.toolset.choice",
      "unrepresentablePart@$.conversation.toolset.tools[0]",
      "unrepresentablePart@$.conversation.turns[0].parts[0]",
      "unrepresentablePart@$.intent.outputFormat",
    ]);
    // 拒绝之前攒下的 loss 一并交出，调用方一次看全。
    expect(result.losses.length).toBeGreaterThan(0);
  });

  it("一个可承载的回合都没有时拒绝，而不是发一条空请求", async () => {
    const result = await outbox.writeOutboxRequest(request({ turns: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.conversation.turns",
    })]);
  });
});

// ── 响应：正常流 ────────────────────────────────────────────────────────────

describe("readOutboxResponse 正常流", () => {
  it("文本增量 + 跨帧累积的 usage + 干净尾帧", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "PO", usage: { outputTokens: 1n } }),
      dataFrame({
        deltaText: "NG",
        usage: { inputTokens: 12n, outputTokens: 5n, cacheReadTokens: 800n, cacheWriteTokens: 200n },
      }),
      endFrame({}),
    ]))));

    expect(kinds(events)).toEqual([
      "messageStart", "partStart", "partDelta", "partDelta", "partEnd", "usage", "messageStop",
    ]);
    expect(events[0]).toEqual({ kind: "messageStart", model: "claude-opus-4-8-high" });
    expect(events.filter((event) => event.kind === "partDelta")).toEqual([
      { kind: "partDelta", index: 0, delta: { kind: "text", text: "PO" } },
      { kind: "partDelta", index: 0, delta: { kind: "text", text: "NG" } },
    ]);
    // input 与 cache 只在末帧给全 —— 只取首帧会漏成 0。
    expect(events.find((event) => event.kind === "usage")).toEqual({
      kind: "usage",
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 200 },
    });
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });
  });

  it("分片的 deltaToolCalls 被拼成完整参数，stopReason=10 归 toolUse", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "I'll write it.", usage: { inputTokens: 8n, outputTokens: 2n } }),
      dataFrame({ deltaToolCalls: [{ id: "toolu_1", name: "Write", argumentsJson: "" }] }),
      dataFrame({ deltaToolCalls: [{ id: "", name: "", argumentsJson: '{"path":"hello.txt"' }] }),
      dataFrame({
        deltaToolCalls: [{ id: "", name: "", argumentsJson: ',"content":"OK"}' }],
        stopReason: 10,
        usage: { outputTokens: 9n },
      }),
      endFrame({}),
    ]))));

    const toolStart = events.find(
      (event) => event.kind === "partStart" && event.part.kind === "toolCall",
    );
    expect(toolStart).toMatchObject({
      kind: "partStart",
      index: 1,
      part: { kind: "toolCall", call: { id: "toolu_1", toolRef: { group: null, name: "Write" } } },
    });
    const toolDelta = events.find(
      (event) => event.kind === "partDelta" && event.delta.kind === "toolInputJson",
    );
    expect(toolDelta).toMatchObject({
      delta: { kind: "toolInputJson", json: '{"path":"hello.txt","content":"OK"}' },
    });
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "toolUse" });
  });

  it("并行工具由各自 id 的首帧切分，分片归属最近开始的那个", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaToolCalls: [{ id: "t1", name: "Read", argumentsJson: "" }] }),
      dataFrame({ deltaToolCalls: [{ id: "", name: "", argumentsJson: '{"path":"a"}' }] }),
      dataFrame({ deltaToolCalls: [{ id: "t2", name: "Read", argumentsJson: "" }] }),
      dataFrame({ deltaToolCalls: [{ id: "", name: "", argumentsJson: '{"path":"b"}' }], stopReason: 10 }),
      endFrame({}),
    ]))));

    const starts = events.filter((event) => event.kind === "partStart");
    expect(starts.map((event) => (event.kind === "partStart" && event.part.kind === "toolCall"
      ? event.part.call.id : null))).toEqual(["t1", "t2"]);
    expect(events.filter((event) => event.kind === "partDelta").map((event) =>
      (event.kind === "partDelta" && event.delta.kind === "toolInputJson" ? event.delta.json : null)))
      .toEqual(['{"path":"a"}', '{"path":"b"}']);
    // 纯工具调用不开空文本块。
    expect(starts.every((event) => event.kind === "partStart" && event.part.kind === "toolCall")).toBe(true);
  });

  it("delta_thinking / delta_signature 走思考块，与文本块自动切边界", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaThinking: "weighing options" }),
      dataFrame({ deltaSignature: "sig-xyz" }),
      dataFrame({ deltaText: "here you go" }),
      endFrame({}),
    ]))));

    expect(kinds(events)).toEqual([
      "messageStart",
      "partStart", "partDelta", "partDelta",
      "partEnd", "partStart", "partDelta",
      "partEnd", "usage", "messageStop",
    ]);
    expect(events[1]).toMatchObject({ kind: "partStart", index: 0, part: { kind: "thinking" } });
    expect(events[3]).toEqual({
      kind: "partDelta", index: 0, delta: { kind: "thinkingSignature", signature: "sig-xyz" },
    });
    expect(events[5]).toMatchObject({ kind: "partStart", index: 1, part: { kind: "text" } });
  });

  it("跨 chunk 切开的帧照样解出同一串事件", async () => {
    const bytes = concat([
      dataFrame({ deltaText: "PO" }),
      dataFrame({ deltaText: "NG", stopReason: 3 }),
      endFrame({}),
    ]);
    const whole = await collect(outbox.readOutboxResponse(connectResponse(bytes)));
    // 3 字节一刀：帧头被劈开、payload 被劈开、尾帧也被劈开。
    const sliced = await collect(outbox.readOutboxResponse(
      connectResponse(bytes, new Array(Math.ceil(bytes.length / 3)).fill(3)),
    ));
    expect(sliced).toEqual(whole);
    expect(whole.at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
  });

  it("thinking_redacted 只是个 bool，不造 redactedThinking 块，只留痕", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ thinkingRedacted: true, deltaText: "ok" }),
      endFrame({}),
    ]))));
    const loss = events.find((event) => event.kind === "loss");
    expect(loss).toMatchObject({ kind: "loss", loss: { path: "$.response.thinkingRedacted", kind: "dropped" } });
    expect(events.some((event) => event.kind === "partStart"
      && event.part.kind === "redactedThinking")).toBe(false);
  });
});

// ── 响应：unhandled 兜底 ────────────────────────────────────────────────────

describe("readOutboxResponse 的 unhandled 兜底", () => {
  it("一个语义字段都没有的帧走 unhandled 而不是被静默吞掉", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "a" }),
      // latency / creditCost 是纯计费与遥测字段：没有任何语义产出。
      dataFrame({ latency: 12.5, creditCost: 3 }),
      endFrame({}),
    ]))));
    const unhandled = events.find((event) => event.kind === "unhandled");
    expect(unhandled).toBeDefined();
    expect(unhandled).toMatchObject({ kind: "unhandled" });
    expect((unhandled as { rawType: string }).rawType).toStartWith("<windsurf-response:");
  });

  it("解不开的 protobuf payload 走 unhandled，并把原字节 base64 带出来", async () => {
    // 0xFF 不是合法的 protobuf tag：这一帧解码必抛。
    const broken = enframe(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      broken, dataFrame({ deltaText: "still here" }), endFrame({}),
    ]))));
    const unhandled = events.find((event) => event.kind === "unhandled");
    expect(unhandled).toMatchObject({ kind: "unhandled", rawType: "<windsurf-frame:undecodable>" });
    // 兜底不是终止：后面的正常帧照常产出。
    expect(events.some((event) => event.kind === "partDelta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "messageStop" });
  });

  it("压缩帧不被当成裸 protobuf 解，走 unhandled", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const compressed = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
    const view = new DataView(compressed.buffer);
    view.setUint8(0, 0b01);
    view.setUint32(1, payload.length, false);
    compressed.set(payload, CONNECT_FRAME_HEADER_BYTES);
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      compressed, dataFrame({ deltaText: "x" }), endFrame({}),
    ]))));
    expect(events[0]).toMatchObject({ kind: "unhandled", rawType: "<windsurf-frame:compressed:flag=1>" });
  });

  it("表里没有的 stop reason 走 unhandled 而不是落进一个默认值", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "x", stopReason: 99 }),
      endFrame({}),
    ]))));
    expect(events.some((event) => event.kind === "unhandled"
      && event.rawType === "<windsurf-stop-reason:99>")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });
  });

  it("尾帧不是 JSON 时既不算成功也不静默：unhandled + error", async () => {
    const payload = new TextEncoder().encode("not json at all");
    const badEnd = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
    const view = new DataView(badEnd.buffer);
    view.setUint8(0, 0b10);
    view.setUint32(1, payload.length, false);
    badEnd.set(payload, CONNECT_FRAME_HEADER_BYTES);
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "x" }), badEnd,
    ]))));
    expect(events.some((event) => event.kind === "unhandled"
      && event.rawType === "<windsurf-trailer:unparseable>")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { retryable: true } });
  });

  it("content-type 不是 connect+proto 时不当成空成功", async () => {
    const events = await collect(outbox.readOutboxResponse(new Response("<html>oops</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    expect(kinds(events)).toEqual(["unhandled", "error"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "unknown" } });
  });
});

// ── 响应：截断与错误 ────────────────────────────────────────────────────────

describe("readOutboxResponse 的终止判定", () => {
  it("流结束却没有结束帧 → error，绝不产出 200 但空的假成功", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "half a sen" }),
    ]))));
    expect(kinds(events)).toEqual(["messageStart", "partStart", "partDelta", "partEnd", "usage", "error"]);
    const last = events.at(-1);
    expect(last).toMatchObject({
      kind: "error",
      error: { kind: "transport", httpStatus: null, retryable: true },
    });
    expect((last as { error: { message: string } }).error.message).toContain("without a Connect end-stream frame");
  });

  it("在一帧中间被掐断时错误文案区分「半帧」与「少个尾帧」", async () => {
    const bytes = dataFrame({ deltaText: "hello" });
    const events = await collect(outbox.readOutboxResponse(
      connectResponse(bytes.slice(0, bytes.length - 3)),
    ));
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: "error", error: { retryable: true } });
    expect((last as { error: { message: string } }).error.message).toContain("residual byte");
  });

  it("干净尾帧但一条数据帧都没有 → error", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(endFrame({}))));
    expect(kinds(events)).toEqual(["error"]);
    expect(events[0]).toMatchObject({
      kind: "error",
      error: { message: expect.stringContaining("never sent a response message") },
    });
  });

  it("上游自报 STOP_REASON_ERROR 时不报成 messageStop", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "x", stopReason: 13 }),
      endFrame({}),
    ]))));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "unknown", retryable: true } });
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);
  });
});

// ── 尾帧应用错误的分类（生产故障的落点） ────────────────────────────────────

describe("Connect 尾帧里的应用错误", () => {
  it("permission_denied 归 permissionDenied 且不可重试 —— 重试会打遍账号池", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      // 生产实测：上游先回一个无内容的首帧，拒绝随后才从尾帧到达。
      dataFrame({ messageId: "m1" }),
      endFrame({ error: { code: "permission_denied", message: "an internal error occurred" } }),
    ]))));

    const error = events.at(-1);
    expect(error).toEqual({
      kind: "error",
      error: {
        kind: "permissionDenied",
        // 传输层是 200：这条错误根本没有 HTTP 状态码，编一个 403 会让整条链路不可信。
        httpStatus: null,
        message: "an internal error occurred",
        retryable: false,
        raw: { error: { code: "permission_denied", message: "an internal error occurred" } },
      },
    });
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);
  });

  it("出错时不铺半截的工具块 —— 那是把垃圾当内容提交", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaToolCalls: [{ id: "t1", name: "Write", argumentsJson: '{"path":' }] }),
      endFrame({ error: { code: "permission_denied", message: "blocked" } }),
    ]))));
    expect(events.some((event) => event.kind === "partStart"
      && event.part.kind === "toolCall")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "permissionDenied" } });
  });

  it("瞬时码可重试、请求码不可重试、配额与限流分得开", async () => {
    const cases: readonly [Record<string, unknown>, string, boolean][] = [
      [{ code: "unavailable", message: "try again" }, "outboxUnavailable", true],
      [{ code: "internal", message: "boom" }, "outboxUnavailable", true],
      [{ code: "deadline_exceeded", message: "slow" }, "outboxUnavailable", true],
      [{ code: "resource_exhausted", message: "rate limit exceeded" }, "rateLimited", true],
      [{ code: "resource_exhausted", message: "monthly quota exhausted" }, "quotaExhausted", false],
      [{ code: "invalid_argument", message: "an internal error occurred" }, "invalidRequest", false],
      [{ code: "invalid_argument", message: "prompt is too long for the context window" },
        "contextLengthExceeded", false],
      [{ code: "unauthenticated", message: "session is no longer valid" }, "permissionDenied", false],
      [{ code: "canceled", message: "client went away" }, "transport", true],
    ];
    for (const [payload, kind, retryable] of cases) {
      const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
        dataFrame({ messageId: "m" }),
        endFrame({ error: payload }),
      ]))));
      expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind, retryable } });
    }
  });

  it("数字码与 SCREAMING_SNAKE 都归一到 Connect 的小写蛇形", () => {
    expect(normalizeConnectCode(7)).toBe("permission_denied");
    expect(normalizeConnectCode("7")).toBe("permission_denied");
    expect(normalizeConnectCode("PERMISSION_DENIED")).toBe("permission_denied");
    expect(normalizeConnectCode("resource-exhausted")).toBe("resource_exhausted");
    expect(normalizeConnectCode(999)).toBeNull();
    expect(normalizeConnectCode(undefined)).toBeNull();
  });

  it("HTTP 层错误走真正的状态码，与尾帧错误是两条路径", async () => {
    const events = await collect(outbox.readOutboxResponse(new Response(
      JSON.stringify({ code: "unauthenticated", message: "invalid session" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));
    expect(events).toEqual([{
      kind: "error",
      error: {
        kind: "permissionDenied",
        httpStatus: 401,
        message: "invalid session",
        retryable: false,
        raw: { code: "unauthenticated", message: "invalid session" },
      },
    }]);

    const overloaded = await collect(outbox.readOutboxResponse(
      new Response("upstream is on fire", { status: 503 }),
    ));
    expect(overloaded[0]).toMatchObject({
      kind: "error",
      error: { kind: "outboxUnavailable", httpStatus: 503, retryable: true },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 真实抓包：12 条 GetChatMessage 请求字节
//
// 前面所有用例的报文都是本仓库自己编出来的 —— 它们能证明「我们编得自洽」，
// 证明不了「我们对上游的形状认知是对的」。这一段拿的是 mitmproxy 从真实 Devin CLI
// 抓下来的字节（`test/fixtures/windsurf_capture/`，`metadata.apiKey` 已抹），
// 12 条**全部得到上游 HTTP 200**。`src/egress/windsurf/index.ts` 里每一条标「抓包」的
// 能力声明，判据都锁在下面这些断言上：夹具被换掉、或者本地 FDS 与真实 wire 对不上，
// 这里就会红，而不是等到线上收到一个语义模糊的 4xx。
// ════════════════════════════════════════════════════════════════════════════

const CAPTURE_DIR = new URL("./fixtures/windsurf_capture/", import.meta.url);

const CAPTURE_FILES = [
  "getchatmessage_017.pb", "getchatmessage_020.pb", "getchatmessage_027.pb",
  "getchatmessage_035.pb", "getchatmessage_065.pb", "getchatmessage_074.pb",
  "getchatmessage_093.pb", "getchatmessage_111.pb", "getchatmessage_117.pb",
  "getchatmessage_130.pb", "getchatmessage_148.pb", "getchatmessage_159.pb",
] as const;

function captureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(file, CAPTURE_DIR)));
}

function captureRequest(file: string): Record<string, any> {
  return fromBinary(schema.requestDesc, captureBytes(file)) as unknown as Record<string, any>;
}

const CAPTURES = CAPTURE_FILES.map((file) => ({ file, message: captureRequest(file) }));
const CAPTURED_PROMPTS = CAPTURES.flatMap(({ file, message }) =>
  (message.chatMessagePrompts as any[]).map((prompt, index) => ({ file, index, prompt })));

describe("抓包：本地 FDS 与真实 wire 对得上", () => {
  it("12 条全部解得开，且没有一个字段落进 $unknown", () => {
    expect(CAPTURES).toHaveLength(12);
    for (const { file, message } of CAPTURES) {
      // $unknown 非空 = 真实客户端发了本地 FDS 不认识的字段，即协议漂移。
      expect({ file, unknown: (message.$unknown as unknown[] | undefined)?.length ?? 0 })
        .toEqual({ file, unknown: 0 });
      for (const prompt of message.chatMessagePrompts as any[]) {
        expect((prompt.$unknown as unknown[] | undefined)?.length ?? 0).toBe(0);
      }
    }
  });

  it("解出来再编回去逐字节相同 —— 出站方向用的是同一套 descriptor", () => {
    for (const { file, message } of CAPTURES) {
      const reencoded = toBinary(schema.requestDesc, message as never);
      expect({ file, same: Buffer.from(reencoded).equals(Buffer.from(captureBytes(file))) })
        .toEqual({ file, same: true });
    }
  });
});

describe("抓包：请求信封的实证形状", () => {
  it("真实客户端只设 11 个顶层字段，其余一个都不发", () => {
    // 反过来说：本出口发的任何一个不在这张表里的顶层字段，都没有抓包背书。
    const alwaysSet = ["prompt", "chatMessagePrompts", "chatModelUid", "requestType",
      "cascadeId", "plannerMode", "metadata", "configuration", "trajectoryReference"] as const;
    const neverSet = ["useInternalChatModel", "internalChatModel", "disableParallelToolCalls",
      "chatModelName", "promptId", "providerSource", "language",
      "toolChoice", "systemPromptCacheOptions", "experimentConfig"] as const;
    for (const { file, message } of CAPTURES) {
      for (const field of alwaysSet) {
        expect({ file, field, empty: isEmptyWireValue(message[field]) })
          .toEqual({ file, field, empty: false });
      }
      for (const field of neverSet) {
        expect({ file, field, empty: isEmptyWireValue(message[field]) })
          .toEqual({ file, field, empty: true });
      }
    }
    // tools / executionId 只有那条「生成会话标题」的短请求没有。
    expect(CAPTURES.filter(({ message }) => (message.tools as any[]).length > 0)).toHaveLength(11);
    expect(CAPTURES.filter(({ message }) => (message.executionId as string).length > 0)).toHaveLength(11);
  });

  it("configuration 的六个标量是 WIRE_NEUTRAL 的证据来源", () => {
    for (const { file, message } of CAPTURES) {
      const configuration = message.configuration;
      expect({ file, ...pickConfiguration(configuration) } as Record<string, unknown>).toEqual({
        file,
        numCompletions: 1n,
        maxNewlines: 400n,
        temperature: 1,
        topK: 40n,
        // 0.95 过 float32 就是这个值 —— 断言写成 0.95 会红，这正是要锁的。
        topP: 0.949999988079071,
        seed: 0n,
        stopPatterns: [],
        serviceTier: "",
      });
    }
    // max_tokens 是唯一不一致的那个：两个量级都被上游受理。
    const byMaxTokens = new Map<string, string[]>();
    for (const { file, message } of CAPTURES) {
      const key = String(message.configuration.maxTokens);
      byMaxTokens.set(key, [...(byMaxTokens.get(key) ?? []), file]);
    }
    expect(byMaxTokens.get("128000")).toHaveLength(10);
    expect(byMaxTokens.get("65535")).toHaveLength(2);
    // 65535 的那两条正是 gemini 家族 —— 所以 WIRE_NEUTRAL 取 128000 只是「被观测最多」。
    expect(CAPTURES.filter(({ message }) => message.configuration.maxTokens === 65535n)
      .map(({ message }) => message.chatModelUid))
      .toEqual(["gemini-3-6-flash-high", "gemini-3-6-flash-high"]);
  });

  it("四个模型家族共用同一个信封，家族只是 chat_model_uid 一个字符串", () => {
    expect([...new Set(CAPTURES.map(({ message }) => message.chatModelUid as string))].sort())
      .toEqual(["gemini-3-6-flash-high", "gpt-5-6-terra-high", "kimi-k3-high", "swe-1-6-fast"]);
    // 家族不同，但 requestType / plannerMode / trajectory_type 完全一致。
    for (const { file, message } of CAPTURES) {
      expect({ file, requestType: message.requestType, plannerMode: message.plannerMode })
        .toEqual({ file, requestType: 5, plannerMode: 1 });
      expect(message.trajectoryReference.trajectoryType).toBe(4);
      expect(message.trajectoryReference.forceBillable).toBe(false);
    }
  });

  it("trajectory 是**跨请求的会话轨迹**，本出口每条请求各起一条 —— 已知的偏离", async () => {
    // 12 条共用同一个 trajectory_id，step_index 从 0 单调数到 11。
    const ids = new Set(CAPTURES.map(({ message }) => message.trajectoryReference.trajectoryId as string));
    expect(ids.size).toBe(1);
    expect(CAPTURES.map(({ message }) => Number(message.trajectoryReference.stepIndex)))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // step_type 不是常量：14 与 0 两种都被受理过。
    expect([...new Set(CAPTURES.map(({ message }) => message.trajectoryReference.stepType))].sort())
      .toEqual([0, 14]);

    // 本出口每条请求都新起一条 trajectory（id 从 traceId 派生、stepIndex 恒 0、stepType 恒 14）。
    // 这与真实客户端不同，但 12 条里 stepIndex=0/stepType=14 的那条同样是 200，
    // 而「跨请求维持轨迹」需要出口持有会话状态 —— 那是调用方的事，不是编译事实。
    const decoded = decodeWire(await outbox.writeOutboxRequest(simpleRequest()));
    expect(decoded.trajectoryReference).toMatchObject({ trajectoryType: 4, stepIndex: 0, stepType: 14 });
  });

  it("metadata 只有 8 个字段，且真实客户端填的是 f 而不是 device_fingerprint", () => {
    for (const { file, message } of CAPTURES) {
      const metadata = message.metadata;
      expect({ file, ...pickMetadata(metadata) } as Record<string, unknown>).toEqual({
        file,
        ideName: "chisel",
        extensionName: "chisel",
        extensionVersion: "3000.2.17",
        ideVersion: "3000.2.17",
        locale: "en",
        os: "linux",
        apiKey: "devin-session-token$REDACTED-BY-FIXTURE-EXTRACTION",
      });
      expect((metadata.f as string).length).toBe(732);
      // 本出口的 WindsurfClientProfile.deviceFingerprint 走的是另一个字段，抓包从不填它。
      expect(metadata.deviceFingerprint).toBe("");
      // request_id 真实客户端送 0；本出口改送 traceId 派生值，这条差异是知情的。
      expect(metadata.requestId).toBe(0n);
      expect(metadata.sessionId).toBe("");
    }
    // CHISEL_PROFILE 就是抓包里那一份，逐字段一致。
    expect(CHISEL_PROFILE).toEqual({
      ideName: "chisel", extensionName: "chisel", extensionVersion: "3000.2.17",
      ideVersion: "3000.2.17", locale: "en", os: "linux",
    });
  });
});

describe("抓包：回合与工具的实证形状", () => {
  it("135 个回合按 source 分成 user(1)/assistant(2)/tool(4) 三档", () => {
    expect(CAPTURED_PROMPTS).toHaveLength(135);
    const bySource = new Map<number, number>();
    for (const { prompt } of CAPTURED_PROMPTS) {
      bySource.set(prompt.source, (bySource.get(prompt.source) ?? 0) + 1);
    }
    expect([...bySource].sort((a, b) => a[0] - b[0])).toEqual([[1, 72], [2, 40], [4, 23]]);
  });

  it("工具结果是一条 source=4 的 prompt：prompt 文本 + tool_call_id，没有 toolResult 子消息", () => {
    const toolResults = CAPTURED_PROMPTS.filter(({ prompt }) => prompt.source === 4);
    expect(toolResults).toHaveLength(23);
    for (const { file, index, prompt } of toolResults) {
      const shape = {
        hasPrompt: (prompt.prompt as string).length > 0,
        hasToolCallId: (prompt.toolCallId as string).length > 0,
        toolCalls: (prompt.toolCalls as unknown[]).length,
        images: (prompt.images as unknown[]).length,
      };
      expect({ file, index, ...shape }).toEqual({
        file, index, hasPrompt: true, hasToolCallId: true, toolCalls: 0, images: 0,
      });
    }
    // 本出口的 lowerToolResult 编出来的正是这个形状 —— 与抓包对齐，不是自创。
    expect(toolResults.map(({ prompt }) => prompt.toolCallId as string))
      .toContain("web_search_1");

    // ⚠ 抓包**没有**覆盖 tool_result_is_error：23 条全是 false。
    // supports 里的 toolResultError 靠的是生产那份证据，不是这 12 条报文。
    expect(toolResults.every(({ prompt }) => prompt.toolResultIsError === false)).toBe(true);
    // 同理 toolResultImage 留在 lossy：没有一条工具结果带过图。
    expect(toolResults.every(({ prompt }) => (prompt.images as unknown[]).length === 0)).toBe(true);
  });

  it("并行工具调用：一个 assistant 回合里 2 个 tool_calls，6 条报文都是 200", () => {
    const parallelTurns = CAPTURED_PROMPTS.filter(
      ({ prompt }) => (prompt.toolCalls as unknown[]).length > 1);
    expect(parallelTurns.map(({ file }) => file)).toEqual([
      "getchatmessage_093.pb", "getchatmessage_111.pb", "getchatmessage_117.pb",
      "getchatmessage_130.pb", "getchatmessage_148.pb", "getchatmessage_159.pb",
    ]);
    for (const { prompt } of parallelTurns) {
      expect(prompt.source).toBe(2);
      expect((prompt.toolCalls as any[]).map((call) => call.name)).toEqual(["web_search", "web_search"]);
      // 两个调用各有自己的 id —— 关联靠 id，不靠位置。
      const ids = (prompt.toolCalls as any[]).map((call) => call.id as string);
      expect(new Set(ids).size).toBe(2);
    }
  });

  it("图片是 ImageData{base64Data,mimeType,caption}，挂在 user 回合上", () => {
    const withImages = CAPTURED_PROMPTS.filter(({ prompt }) => (prompt.images as unknown[]).length > 0);
    expect(withImages.reduce((sum, { prompt }) => sum + (prompt.images as unknown[]).length, 0)).toBe(11);
    for (const { prompt } of withImages) {
      expect(prompt.source).toBe(1);
      for (const image of prompt.images as any[]) {
        expect(image.mimeType).toBe("image/png");
        // caption 是空串 —— 生产实现会往 prompt 里插 `[Image 1: …]` 占位文案，抓包证明真实客户端不插。
        expect(image.caption).toBe("");
        expect((image.base64Data as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("ChatToolDefinition 只用 name/description/json_schema_string，MCP 靠元工具而不是 server_name", () => {
    const tools = CAPTURES.flatMap(({ message }) => message.tools as any[]);
    expect(tools).toHaveLength(253);
    for (const tool of tools) {
      expect((tool.name as string).length).toBeGreaterThan(0);
      expect((tool.description as string).length).toBeGreaterThan(0);
      expect((tool.jsonSchemaString as string).length).toBeGreaterThan(0);
      // 这六个全空 —— toolGroup / toolFreeform / toolBuiltin 三条判断的直接依据。
      for (const field of ["serverName", "strict", "isCustomTool", "customToolGrammar",
        "attributionFieldNames", "computerUseConfig"] as const) {
        expect({ name: tool.name, field, empty: isEmptyWireValue(tool[field]) })
          .toEqual({ name: tool.name, field, empty: true });
      }
    }
    const names = (CAPTURES[0]?.message.tools as any[]).map((tool) => tool.name as string);
    // MCP 分组是四个普通 function 元工具，不是 server_name。
    expect(names).toContain("mcp_call_tool");
    expect(names).toContain("mcp_list_servers");
    // web_search 也是普通 function 工具，不是上游内建能力 —— toolBuiltin 因此仍然不可承载。
    expect(names).toContain("web_search");
    expect(names).toHaveLength(23);
  });
});

describe("抓包：thinking / signature / geminiThoughtSignature", () => {
  it("thinking 在 39/135 个回合上真实回传 —— supports 的直接依据", () => {
    const withThinking = CAPTURED_PROMPTS.filter(
      ({ prompt }) => (prompt.thinking as string).length > 0);
    expect(withThinking).toHaveLength(39);
    // 全部挂在 assistant 回合上。
    expect(withThinking.every(({ prompt }) => prompt.source === 2)).toBe(true);
  });

  it("signature 稀疏(2/135)且**带家族标签**，IR 装不下标签 —— 这才是 lossy 的理由", () => {
    const withSignature = CAPTURED_PROMPTS.filter(
      ({ prompt }) => (prompt.signature as string).length > 0);
    expect(withSignature).toHaveLength(2);
    for (const { prompt } of withSignature) {
      expect((prompt.signature as string).length).toBe(1984);
      expect(prompt.signatureType).toBe("openai");
      expect((prompt.thinking as string).length).toBeGreaterThan(0);
    }
    // signature_type="openai" 却出现在 gemini 请求里：签名是上一轮由别家签发后原样带回的。
    expect(withSignature.map(({ file }) => file))
      .toEqual(["getchatmessage_148.pb", "getchatmessage_159.pb"]);
    expect(withSignature.every(({ file }) =>
      CAPTURES.find((one) => one.file === file)?.message.chatModelUid === "gemini-3-6-flash-high"))
      .toBe(true);
  });

  it("geminiThoughtSignature 在 135 个回合上**全为空** —— 零行为实证，不做任何处理", () => {
    // 这条用例是防复发的：曾经有一份简报把它读成「每个回合都带、非空」，
    // 原因是拿 `!== ""` 判一个 bytes 字段（空 Uint8Array 恒不等于空串）。
    // 正确的判空是看 length。
    for (const { prompt } of CAPTURED_PROMPTS) {
      const signature = prompt.geminiThoughtSignature as Uint8Array;
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(0);
    }
    // 而且它是 implicit presence 的 bytes：空值根本不上 wire。
    // field #17 的 tag 是 (17<<3)|2 = 138 = 0x8A，varint 编码 0x8A 0x01。
    for (const file of CAPTURE_FILES) {
      const bytes = captureBytes(file);
      let hits = 0;
      for (let i = 0; i + 1 < bytes.length; i += 1) {
        if (bytes[i] === 0x8a && bytes[i + 1] === 0x01) hits += 1;
      }
      expect({ file, hits }).toEqual({ file, hits: 0 });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 客户端身份：windsurf 自己的 owner option
// ════════════════════════════════════════════════════════════════════════════

/** Claude Code 的 system 真实排布：计费头一块、身份行**单独一块**、正文一块。 */
const CLAUDE_CODE_SYSTEM: readonly IRPart[] = [
  { kind: "text", text: "x-anthropic-billing-header: cc_version=2.1.221.ebe; cc_entrypoint=cli;" },
  { kind: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { kind: "text", text: "\nYou are an interactive agent that helps users with software engineering tasks." },
];
describe("客户端身份行：windsurf 私有策略，强制身份行为第一行", () => {
  it("抓包 12/12 条的 system 首行就是 WINDSURF_OBSERVED_IDENTITY_LINE", () => {
    const devinRequests = CAPTURES.filter(({ message }) =>
      (message.prompt as string).startsWith("You are "));
    expect(devinRequests.filter(({ message }) =>
      (message.prompt as string).split("\n")[0] === WINDSURF_OBSERVED_IDENTITY_LINE))
      .toHaveLength(11);
    // 第 12 条是「生成会话标题」的短 system，没有身份行 —— 如实记下来，不假装 12/12。
    expect(CAPTURES.find(({ file }) => file === "getchatmessage_020.pb")?.message.prompt)
      .toStartWith("You are a session title generator.");
    for (const { message } of devinRequests.filter(({ message }) => (message.tools as any[]).length > 0)) {
      expect((message.prompt as string).length).toBeGreaterThan(20000);
      expect((message.tools as any[]).length).toBe(23);
    }
  });

  /**
   * 后置条件，**不依赖锚点命中**：非空 system 出站后第 0 行一定是身份行。
   *
   * 这是「删 + 强制前置」相对「就地替换」的全部价值：纯替换在锚点漂掉时会静默什么都不做，
   * 出站带着外来身份行上去，症状是「忽然每条都被拒」而代码里一处报错都没有。
   */
  it("默认策略：身份行强制第一行，CC 身份行被删，其余 system 一字不动", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: CLAUDE_CODE_SYSTEM,
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    // 位置是强制的：真实客户端身份行就在第 0 行，就地替换会把它落在计费头之后。
    expect(prompt.split("\n")[0]).toBe(WINDSURF_OBSERVED_IDENTITY_LINE);
    expect(prompt).not.toContain("You are Claude Code");
    // **不是**把整个 system 塌缩成中性提示 —— 用户的指令全都还在。
    expect(prompt).toContain("x-anthropic-billing-header");
    expect(prompt).toContain("interactive agent that helps users with software engineering tasks");

    const loss = expectOk(result).losses.find((one) => one.path === "$.conversation.system");
    expect(loss?.kind).toBe("substituted");
    expect(loss?.detail).toContain("第一行");
    expect(loss?.detail).toContain("实测");
    expect(loss?.detail).toContain("passthrough");
  });

  it("passthrough 一步都不改，也不记 loss", async () => {
    const passthrough = createWindsurfOutbox({
      model: "claude-opus-4-8-high",
      apiKey: "devin-session-token$h.e.sig",
      systemIdentity: { kind: "passthrough" },
    });
    const result = await passthrough.writeOutboxRequest(request({
      system: CLAUDE_CODE_SYSTEM,
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    expect(decodeWire(result).prompt).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(expectOk(result).losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);
  });

  it("锚点一条都没命中 → 身份行照样是第一行，客户端原文一字不动地跟在后面", async () => {
    const result = await outbox.writeOutboxRequest(request({
      // 提到了 Claude Code，但不是那一行身份行 —— 判据是整行精确相等，不是子串。
      system: [{ kind: "text", text: "The user is running Claude Code, Anthropic's official CLI for Claude, in a terminal." }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    expect(prompt).toBe(
      `${WINDSURF_OBSERVED_IDENTITY_LINE}\n\n`
      + "The user is running Claude Code, Anthropic's official CLI for Claude, in a terminal.",
    );
    const loss = expectOk(result).losses.find((one) => one.path === "$.conversation.system");
    expect(loss?.detail).toContain("一行都没删");
  });

  it("本来就合规 → 一个字节都不动（幂等，多轮不会越堆越长）", async () => {
    const devin = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: `${WINDSURF_OBSERVED_IDENTITY_LINE}\n\nDo the thing.` }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    expect(decodeWire(devin).prompt).toBe(`${WINDSURF_OBSERVED_IDENTITY_LINE}\n\nDo the thing.`);
    expect(expectOk(devin).losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);

    // 两次过同一条策略，结果逐字节相同 —— 身份行不会越堆越多。
    const once = decodeWire(await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: "plain instructions" }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }))).prompt as string;
    const twice = decodeWire(await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: once }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }))).prompt as string;
    expect(twice).toBe(once);
  });

  it("身份行埋在中间 → 提到第一行，不留下第二条", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [{ kind: "text", text: `preamble\n${WINDSURF_OBSERVED_IDENTITY_LINE}\ntail` }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    expect(prompt).toBe(`${WINDSURF_OBSERVED_IDENTITY_LINE}\n\npreamble\ntail`);
    // 全文只有一条身份行。
    expect(prompt.split("\n").filter((line) => line === WINDSURF_OBSERVED_IDENTITY_LINE)).toHaveLength(1);
  });

  it("空 system 是故意的例外：不补身份行，因为那是凭空发明客户端没写过的指令", async () => {
    const empty = await outbox.writeOutboxRequest(request({
      system: [],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    expect(decodeWire(empty).prompt).toBe("");
    expect(expectOk(empty).losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);
  });

  it("多条外来身份行一次删干净", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [
        { kind: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { kind: "text", text: "keep me" },
        { kind: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      ],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    expect(prompt.split("\n")[0]).toBe(WINDSURF_OBSERVED_IDENTITY_LINE);
    expect(prompt).toContain("keep me");
    expect(prompt).not.toContain("You are Claude Code");
    expect(prompt).not.toContain("Claude Agent SDK");
    expect(expectOk(result).losses.find((one) => one.path === "$.conversation.system")?.detail)
      .toContain("删掉 2 条外来身份行");
  });

  it("调用方可以自定身份行与被取代清单", async () => {
    const custom = createWindsurfOutbox({
      model: "claude-opus-4-8-high",
      apiKey: "devin-session-token$h.e.sig",
      systemIdentity: {
        kind: "ensureIdentityLine",
        identityLine: "I am human.",
        supersededLines: ["I am robot."],
        blockedSegmentPrefixes: [],
      },
    });
    const result = await custom.writeOutboxRequest(request({
      system: [{ kind: "text", text: "I am robot.\nkeep\nI am robot." }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    // 两条都删掉，身份行统一在第一行 —— 没有「只换第一处」这种半吊子状态。
    expect(decodeWire(result).prompt).toBe("I am human.\n\nkeep");

    // 换了自定清单之后，Claude Code 那一行不再是「被取代」的对象，但身份行照样在第一行。
    const other = await custom.writeOutboxRequest(request({
      system: CLAUDE_CODE_SYSTEM,
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const otherPrompt = decodeWire(other).prompt as string;
    expect(otherPrompt.split("\n")[0]).toBe("I am human.");
    expect(otherPrompt).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
  });


  it("空 system 是故意的例外：不 prepend，因为那是凭空发明客户端没写过的指令", async () => {
    const empty = await outbox.writeOutboxRequest(request({
      system: [],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    expect(decodeWire(empty).prompt).toBe("");
    expect(expectOk(empty).losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);
  });


  it("反例：这条特化**只**属于 windsurf，同一条 IR 走 anthropic 出口一个字都不变", async () => {
    const irRequest = request({
      system: CLAUDE_CODE_SYSTEM,
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: intent({ stopping: { maxOutputTokens: clientValue(1024) } }),
    });
    const anthropic = createAnthropicOutbox({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      model: "claude-opus-4-6",
    });
    const result = await anthropic.writeOutboxRequest(irRequest);
    if (!result.ok) throw new Error(`anthropic build failed: ${JSON.stringify(result.problems)}`);
    const body = JSON.parse(result.wire.body as string) as { system: { text: string }[] };
    // 身份行原样进 anthropic 的 system —— windsurf 的替换没有泄漏成通用 repair。
    expect(body.system.map((block) => block.text))
      .toEqual(CLAUDE_CODE_SYSTEM.map((part) => (part.kind === "text" ? part.text : "")));
    expect(JSON.stringify(body)).not.toContain("Devin");
    // 也没有任何一条 windsurf 的 loss 混进别家出口。
    expect(result.losses.every((loss) => loss.outbox !== "windsurf")).toBe(true);
    expect(result.losses.filter((loss) => loss.path === "$.conversation.system")).toEqual([]);

    // 而 IROutboxProfile 里不该长出任何身份/策略字段 —— 它只描述三条 wire 事实加一个出口名。
    const profileKeys = Object.keys(outbox.profile);
    expect(profileKeys).toContain("supports");
    expect(profileKeys).toContain("lossy");
    expect(profileKeys).toContain("mandatory");
    expect(profileKeys.some((key) => /identity|policy|content|rewrite/iu.test(key))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 回读侧：抓包在响应帧上钉住的两件事
// ════════════════════════════════════════════════════════════════════════════

describe("readOutboxResponse：抓包钉住的响应形状", () => {
  it("delta_signature_type 送不进 IR，如实记一条 loss，签名照常下发", async () => {
    // 抓包实证：2107 帧里 delta_signature 与 delta_signature_type 各 2 次、成对出现。
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaThinking: "weighing" }),
      dataFrame({ deltaSignature: "sig-1984", deltaSignatureType: "openai" }),
      endFrame({}),
    ]))));
    expect(events.some((event) => event.kind === "partDelta"
      && event.delta.kind === "thinkingSignature"
      && event.delta.signature === "sig-1984")).toBe(true);
    const loss = events.find((event) => event.kind === "loss");
    expect(loss).toMatchObject({
      kind: "loss",
      loss: { path: "$.response.deltaSignatureType", kind: "dropped", outbox: "windsurf" },
    });
    expect((loss as { loss: { detail: string } }).loss.detail).toContain("openai");
    expect(events.at(-1)).toMatchObject({ kind: "messageStop" });
  });

  it("response_dimension_groups 没有映射：只带它的一帧走 unhandled，不被静默吞掉", async () => {
    const events = await collect(outbox.readOutboxResponse(connectResponse(concat([
      dataFrame({ deltaText: "a" }),
      // ⚠ 真实流里每帧都带 messageId，所以这条兜底在抓包上从未被触发；
      //   它防的是「上游哪天单发一帧维度信息」。这里构造的正是那种帧。
      dataFrame({ responseDimensionGroups: [{ dimensions: [] }] }),
      endFrame({}),
    ]))));
    const unhandled = events.find((event) => event.kind === "unhandled");
    expect(unhandled).toBeDefined();
    expect((unhandled as { rawType: string }).rawType).toStartWith("<windsurf-response:");
    // 兜底不是终止：前面的文本照常产出，收尾照常。
    expect(events.some((event) => event.kind === "partDelta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "messageStop" });
  });
});

/**
 * 摘除被上游内容策略拦下的段落 —— 判据全部来自 2026-08-05 打真实 `server.codeium.com`
 * 的逐段二分（模型 claude-opus-4-6，Claude Code 2.1.221 的真实 system 共 9929 字符）。
 *
 * 二分结论：12 段里只有 3 段会被拒（身份行 57 字符走泛化 permission_denied，
 * `IMPORTANT: Assist with authorized security testing…` 459 字符与 `# Environment` 973 字符
 * 走 content policy），其余 8 段共 8507 字符全部放行。摘 3 段 + 换身份行之后，
 * 带 12 个真实 Claude Code 工具实测得到 200。
 *
 * 所以这里锁的性质是：**只摘该摘的，别的一个字都不许动**。
 */
describe("内容策略段落摘除：只摘实测触发的那几段", () => {
  const CC_SECURITY_PARAGRAPH =
    "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and "
    + "educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, "
    + "supply chain compromise, or detection evasion for malicious purposes.";
  const CC_ENVIRONMENT_SECTION =
    "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /tmp\n"
    + " - You are powered by the model named Opus 5.";
  const KEEP = "# Delivering work\nDo ordinary work as asked, acting on the actual request.";

  it("两个实测触发段被整段摘掉，其余段落逐字保留", async () => {
    const result = await outbox.writeOutboxRequest(request({
      system: [
        { kind: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { kind: "text", text: CC_SECURITY_PARAGRAPH },
        { kind: "text", text: KEEP },
        { kind: "text", text: CC_ENVIRONMENT_SECTION },
      ],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    // 摘掉的两段一个字都不留。
    expect(prompt).not.toContain("authorized security testing");
    expect(prompt).not.toContain("# Environment");
    // 没被摘的那段逐字还在 —— 这才是「只摘 3 段」相对「整体塌缩」的全部价值。
    expect(prompt).toContain(KEEP);
    // 身份行同时被换掉：实测两套机制必须一起处理，缺一仍然被拒。
    expect(prompt).toContain(WINDSURF_OBSERVED_IDENTITY_LINE);
    expect(prompt).not.toContain("You are Claude Code");

    const systemLosses = expectOk(result).losses.filter((one) => one.path === "$.conversation.system");
    // 两条 dropped（各一段）+ 一条 substituted（身份行）。
    expect(systemLosses.filter((one) => one.kind === "dropped")).toHaveLength(2);
    expect(systemLosses.filter((one) => one.kind === "substituted")).toHaveLength(1);
    for (const loss of systemLosses.filter((one) => one.kind === "dropped")) {
      expect(loss.detail).toContain("content policy");
      expect(loss.detail).toContain("passthrough");
    }
  });

  it("没有触发段就不摘，也不记 dropped —— 判据是段首前缀，不是含有关键词", async () => {
    const result = await outbox.writeOutboxRequest(request({
      // 正文里提到了 security testing，但不是以那条前缀开头的段。
      system: [{ kind: "text", text: "We discuss authorized security testing in this project." }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const prompt = decodeWire(result).prompt as string;
    expect(prompt).toContain("We discuss authorized security testing in this project.");
    expect(expectOk(result).losses.filter((one) => one.path === "$.conversation.system" && one.kind === "dropped"))
      .toEqual([]);
  });

  it("passthrough 连触发段都不摘 —— 调用方要的是逐字节透传", async () => {
    const raw = createWindsurfOutbox({
      model: "claude-opus-4-8-high",
      apiKey: "devin-session-token$h.e.sig",
      systemIdentity: { kind: "passthrough" },
    });
    const result = await raw.writeOutboxRequest(request({
      system: [{ kind: "text", text: CC_SECURITY_PARAGRAPH }, { kind: "text", text: CC_ENVIRONMENT_SECTION }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    expect(decodeWire(result).prompt).toBe(`${CC_SECURITY_PARAGRAPH}\n\n${CC_ENVIRONMENT_SECTION}`);
    expect(expectOk(result).losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);
  });

  it("反例：段落摘除只属于 windsurf，同一条 IR 走 anthropic 出口一个字都不少", async () => {
    const irRequest = request({
      system: [{ kind: "text", text: CC_SECURITY_PARAGRAPH }, { kind: "text", text: CC_ENVIRONMENT_SECTION }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: intent({ stopping: { maxOutputTokens: clientValue(1024) } }),
    });
    const anthropic = createAnthropicOutbox({ baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m" });
    const built = await anthropic.writeOutboxRequest(irRequest);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const body = JSON.stringify(built.wire.body);
    expect(body).toContain("authorized security testing");
    expect(body).toContain("# Environment");
    expect(built.losses.filter((one) => one.path === "$.conversation.system")).toEqual([]);
  });
});
