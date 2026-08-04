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
import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createWindsurfUpstream } from "../src/egress/windsurf/index.ts";
import {
  CONNECT_FRAME_HEADER_BYTES, createDeframeState, deframe, enframe, parseConnectTrailer,
} from "../src/egress/windsurf/connect_frame.ts";
import { getSharedWindsurfSchema, WINDSURF_TYPES } from "../src/egress/windsurf/schema.ts";
import { normalizeConnectCode } from "../src/egress/windsurf/errors.ts";
import { checkUpstreamSupport } from "../src/ir/admission.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { clientValue, defaultValue } from "../src/ir/types.ts";
import type {
  IREvent, IRIntent, IRPart, IRRequest, IRToolset, IRTurn, UpstreamRequestBuildResult,
} from "../src/ir/types.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const schema = getSharedWindsurfSchema();

const egress = createWindsurfUpstream({
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

function expectOk(result: UpstreamRequestBuildResult<Uint8Array>): Extract<UpstreamRequestBuildResult<Uint8Array>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok build, got problems: ${JSON.stringify(result.problems)}`);
  }
  return result;
}

/** 解回出站的 GetChatMessageRequest —— 断言的是真字节，不是构造它的那个对象。 */
function decodeWire(result: UpstreamRequestBuildResult<Uint8Array>): Record<string, any> {
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
    const { supports, lossy } = egress.profile;
    for (const capability of supports) expect(lossy.has(capability)).toBe(false);
    for (const capability of ["document", "toolBuiltin", "toolChoiceSpecific", "structuredOutput"] as const) {
      expect(supports.has(capability)).toBe(false);
      expect(lossy.has(capability)).toBe(false);
    }
  });

  it("thinking 只进 lossy —— 字段存在但上游是否消费未经实证", () => {
    expect(egress.profile.supports.has("thinking")).toBe(false);
    expect(egress.profile.lossy.has("thinking")).toBe(true);
    expect(egress.profile.lossy.has("thinkingSignature")).toBe(true);
    expect(egress.profile.lossy.has("cacheBreakpoint")).toBe(true);
  });

  it("准入把结构化输出指到精确路径而不是笼统报错", () => {
    const irRequest = simpleRequest({
      intent: intent({
        outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }),
      }),
    });
    const check = checkUpstreamSupport(irRequest, egress.profile);
    expect(check.admitted).toBe(false);
    expect(check.unsupported.map((need) => need.capability)).toContain("structuredOutput");
    expect(check.unsupported[0]?.paths).toContain("$.intent.outputFormat");
  });
});

// ── 出站请求构造 ────────────────────────────────────────────────────────────

describe("writeUpstreamRequest 构造真实 GetChatMessage", () => {
  it("system 进顶层 prompt，回合进 chat_message_prompts，模型进 chat_model_uid", async () => {
    const decoded = decodeWire(await egress.writeUpstreamRequest(simpleRequest()));
    expect(decoded.prompt).toBe("You are a coding assistant.");
    expect(decoded.chatModelUid).toBe("claude-opus-4-8-high");
    expect(decoded.requestType).toBe(5);
    expect(decoded.plannerMode).toBe(1);
    expect(decoded.chatMessagePrompts).toHaveLength(1);
    expect(decoded.chatMessagePrompts[0]).toMatchObject({ source: 1, prompt: "hi" });
    expect(decoded.metadata.apiKey).toBe("devin-session-token$h.eyJzZXNzaW9uX2lkIjoicyJ9.sig");
    expect(decoded.trajectoryReference).toMatchObject({ trajectoryType: 4, stepType: 14 });
  });

  it("body 保留原始 Connect 字节，头里给 Connect 的两个必需头", async () => {
    const wire = expectOk(await egress.writeUpstreamRequest(simpleRequest())).wire;
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
    const first = expectOk(await egress.writeUpstreamRequest(irRequest)).wire.body as Uint8Array;
    const second = expectOk(await egress.writeUpstreamRequest(irRequest)).wire.body as Uint8Array;
    expect(second).toEqual(first);
    // traceId 变了才该变：id 是从 traceId 派生的，不是随机的。
    const other = expectOk(await egress.writeUpstreamRequest(
      simpleRequest({ traceId: "tr_other" }),
    )).wire.body as Uint8Array;
    expect(other).not.toEqual(first);
  });

  it("工具往返：assistant 的 toolCall 进 toolCalls，结果各自成一条 source=4 的 prompt", async () => {
    const decoded = decodeWire(await egress.writeUpstreamRequest(request({
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
    const decoded = decodeWire(await egress.writeUpstreamRequest(request({
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
    const decoded = decodeWire(await egress.writeUpstreamRequest(request({
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
    const result = await egress.writeUpstreamRequest(request({
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

  it("思考与签名写进 thinking/signature，并记一条「未经实证」的 loss", async () => {
    const result = await egress.writeUpstreamRequest(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{
        role: "assistant",
        parts: [
          { kind: "thinking", text: "let me think", signature: "sig-abc" },
          { kind: "text", text: "done" },
        ],
      }],
    }));
    const decoded = decodeWire(result);
    expect(decoded.chatMessagePrompts[0]).toMatchObject({
      thinking: "let me think", signature: "sig-abc", prompt: "done",
    });
    const thinkingLoss = expectOk(result).losses.find(
      (loss) => loss.path === "$.conversation.turns[0]" && loss.detail.includes("thinking/signature"),
    );
    expect(thinkingLoss?.kind).toBe("degraded");
    expect(thinkingLoss?.detail).toContain("没有任何一次真实调用证明");
  });

  it("客户端给了采样参数就用客户端的，没给才由出口命名并留痕", async () => {
    const bare = await egress.writeUpstreamRequest(simpleRequest());
    const bareDecoded = decodeWire(bare);
    expect(bareDecoded.configuration).toMatchObject({ temperature: 1, topK: 40n, topP: 0.95 });
    const substitution = expectOk(bare).losses.find((loss) => loss.path === "$.intent");
    expect(substitution?.kind).toBe("substituted");
    expect(substitution?.detail).toContain("temperature");
    expect(substitution?.detail).toContain("max_newlines");

    const explicit = await egress.writeUpstreamRequest(simpleRequest({
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
    const decoded = decodeWire(await egress.writeUpstreamRequest(simpleRequest({
      toolset: { ...EMPTY_TOOLSET, parallel: clientValue(false) },
    })));
    expect(decoded.disableParallelToolCalls).toBe(true);
  });

  it("effort 记成 substituted 并说明它是靠模型 id 表达的", async () => {
    const result = await egress.writeUpstreamRequest(simpleRequest({
      intent: intent({ reasoning: clientValue({ mode: "enabled", display: "summarized", effort: "high" }) }),
    }));
    const loss = expectOk(result).losses.find((one) => one.path === "$.intent.reasoning.effort");
    expect(loss?.kind).toBe("substituted");
    expect(loss?.detail).toContain("claude-opus-4-8-high");
  });
});

// ── 拒绝 ────────────────────────────────────────────────────────────────────

describe("writeUpstreamRequest 的拒绝条件", () => {
  it("悬空的工具调用带精确路径拒绝", async () => {
    const result = await egress.writeUpstreamRequest(request({
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
    const result = await egress.writeUpstreamRequest(request({
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
    const result = await egress.writeUpstreamRequest(request({
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
    const result = await egress.writeUpstreamRequest(request({
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
    const result = await egress.writeUpstreamRequest(request({ turns: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({
      kind: "requiredFieldMissing",
      path: "$.conversation.turns",
    })]);
  });
});

// ── 响应：正常流 ────────────────────────────────────────────────────────────

describe("readUpstreamResponse 正常流", () => {
  it("文本增量 + 跨帧累积的 usage + 干净尾帧", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const whole = await collect(egress.readUpstreamResponse(connectResponse(bytes)));
    // 3 字节一刀：帧头被劈开、payload 被劈开、尾帧也被劈开。
    const sliced = await collect(egress.readUpstreamResponse(
      connectResponse(bytes, new Array(Math.ceil(bytes.length / 3)).fill(3)),
    ));
    expect(sliced).toEqual(whole);
    expect(whole.at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
  });

  it("thinking_redacted 只是个 bool，不造 redactedThinking 块，只留痕", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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

describe("readUpstreamResponse 的 unhandled 兜底", () => {
  it("一个语义字段都没有的帧走 unhandled 而不是被静默吞掉", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
      compressed, dataFrame({ deltaText: "x" }), endFrame({}),
    ]))));
    expect(events[0]).toMatchObject({ kind: "unhandled", rawType: "<windsurf-frame:compressed:flag=1>" });
  });

  it("表里没有的 stop reason 走 unhandled 而不是落进一个默认值", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
      dataFrame({ deltaText: "x" }), badEnd,
    ]))));
    expect(events.some((event) => event.kind === "unhandled"
      && event.rawType === "<windsurf-trailer:unparseable>")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { retryable: true } });
  });

  it("content-type 不是 connect+proto 时不当成空成功", async () => {
    const events = await collect(egress.readUpstreamResponse(new Response("<html>oops</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    expect(kinds(events)).toEqual(["unhandled", "error"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "unknown" } });
  });
});

// ── 响应：截断与错误 ────────────────────────────────────────────────────────

describe("readUpstreamResponse 的终止判定", () => {
  it("流结束却没有结束帧 → error，绝不产出 200 但空的假成功", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(
      connectResponse(bytes.slice(0, bytes.length - 3)),
    ));
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: "error", error: { retryable: true } });
    expect((last as { error: { message: string } }).error.message).toContain("residual byte");
  });

  it("干净尾帧但一条数据帧都没有 → error", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(endFrame({}))));
    expect(kinds(events)).toEqual(["error"]);
    expect(events[0]).toMatchObject({
      kind: "error",
      error: { message: expect.stringContaining("never sent a response message") },
    });
  });

  it("上游自报 STOP_REASON_ERROR 时不报成 messageStop", async () => {
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
      dataFrame({ deltaToolCalls: [{ id: "t1", name: "Write", argumentsJson: '{"path":' }] }),
      endFrame({ error: { code: "permission_denied", message: "blocked" } }),
    ]))));
    expect(events.some((event) => event.kind === "partStart"
      && event.part.kind === "toolCall")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "permissionDenied" } });
  });

  it("瞬时码可重试、请求码不可重试、配额与限流分得开", async () => {
    const cases: readonly [Record<string, unknown>, string, boolean][] = [
      [{ code: "unavailable", message: "try again" }, "upstreamUnavailable", true],
      [{ code: "internal", message: "boom" }, "upstreamUnavailable", true],
      [{ code: "deadline_exceeded", message: "slow" }, "upstreamUnavailable", true],
      [{ code: "resource_exhausted", message: "rate limit exceeded" }, "rateLimited", true],
      [{ code: "resource_exhausted", message: "monthly quota exhausted" }, "quotaExhausted", false],
      [{ code: "invalid_argument", message: "an internal error occurred" }, "invalidRequest", false],
      [{ code: "invalid_argument", message: "prompt is too long for the context window" },
        "contextLengthExceeded", false],
      [{ code: "unauthenticated", message: "session is no longer valid" }, "permissionDenied", false],
      [{ code: "canceled", message: "client went away" }, "transport", true],
    ];
    for (const [payload, kind, retryable] of cases) {
      const events = await collect(egress.readUpstreamResponse(connectResponse(concat([
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
    const events = await collect(egress.readUpstreamResponse(new Response(
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

    const overloaded = await collect(egress.readUpstreamResponse(
      new Response("upstream is on fire", { status: 503 }),
    ));
    expect(overloaded[0]).toMatchObject({
      kind: "error",
      error: { kind: "upstreamUnavailable", httpStatus: 503, retryable: true },
    });
  });
});
