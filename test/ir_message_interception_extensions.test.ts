/** 内置 IRMessage 拦截链的时序、可变引用与三种边界。 */
import { describe, expect, it } from "bun:test";
import { createChatCompletionsUpstream } from "../src/egress/openai_chat_completions.ts";
import { writeAnthropicResponse } from "../src/ingress/anthropic_encode.ts";
import { writeChatCompletionsResponse, writeResponsesResponse } from "../src/ingress/openai_encode.ts";
import {
  createIRMessageInterceptionExtensions, executeIRMessageInterceptorChain,
  observeCompleteIRResponseBeforeStreamTermination, type IRMessageInterceptor,
} from "../src/ir/ir_message_interception_extensions.ts";
import { iterateSse } from "../src/ir/sse.ts";
import { defaultValue, type IREvent, type IRRequest } from "../src/ir/types.ts";

async function* eventsOf(events: readonly IREvent[]): AsyncGenerator<IREvent> {
  for (const event of events) yield event;
}

const baseRequest: IRRequest = {
  traceId: "callback-test",
  protocol: "openai_responses",
  model: "gpt-test",
  conversation: { system: [], turns: [], toolset: { tools: [], groups: [], choice: defaultValue({ kind: "auto" }), parallel: defaultValue(true) } },
  intent: {
    reasoning: defaultValue({ mode: "auto", display: "summarized" }), outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"), sampling: {}, stopping: {}, contextEdits: [], stream: defaultValue(false), identity: {},
  },
  requires: [],
};

describe("IRMessage inbox request interceptor chain", () => {
  it("收到原对象的强类型可变引用，并支持注销", async () => {
    const extensions = createIRMessageInterceptionExtensions();
    const request = structuredClone(baseRequest) as typeof baseRequest;
    const unregister = extensions.inboxRequestInterceptorChain.addInterceptor({
      interceptorId: "rewrite-model",
      async intercept(value, _context, chain) {
        value.model = "audited-model";
        return chain.proceed(value);
      },
    });
    await extensions.inboxRequestInterceptorChain.executeInterceptors(request as never, { traceId: request.traceId, protocol: request.protocol });
    expect(request.model).toBe("audited-model");
    unregister();
    await extensions.inboxRequestInterceptorChain.executeInterceptors(request as never, { traceId: request.traceId, protocol: request.protocol });
    expect(request.model).toBe("audited-model");
  });

  it("request 是 OkHttp 风格洋葱链：下行按注册顺序，上行反向返回", async () => {
    const extensions = createIRMessageInterceptionExtensions();
    const order: string[] = [];
    extensions.inboxRequestInterceptorChain.addInterceptor({
      interceptorId: "outer",
      async intercept(request, _context, chain) {
        order.push("outer:before");
        request.model = "rewritten";
        const result = await chain.proceed(request);
        order.push("outer:after");
        return result;
      },
    });
    extensions.inboxRequestInterceptorChain.addInterceptor({
      interceptorId: "inner",
      async intercept(request, _context, chain) {
        order.push(`inner:before:${request.model}`);
        const result = await chain.proceed(request);
        order.push("inner:after");
        return result;
      },
    });
    const request = structuredClone(baseRequest) as typeof baseRequest;
    await extensions.inboxRequestInterceptorChain.executeInterceptors(request as never, { traceId: request.traceId, protocol: request.protocol });
    expect(order).toEqual(["outer:before", "inner:before:rewritten", "inner:after", "outer:after"]);
  });

  it("同一环重复 proceed 会失败，不能暗中重放下游", async () => {
    const invalid: IRMessageInterceptor<number, undefined> = {
      interceptorId: "double-proceed",
      async intercept(value, _context, chain) {
        await chain.proceed(value);
        return chain.proceed(value);
      },
    };
    await expect(executeIRMessageInterceptorChain(1, undefined, [invalid]))
      .rejects.toThrow("IR interceptor called proceed twice: double-proceed");
  });
});

describe("outbox SSE frame interceptor chain", () => {
  it("只在跨 chunk 拼出的完整 frame 后运行，修改会传给下游", async () => {
    const seen: string[] = [];
    const encoded = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.encode("data: bef"));
        controller.enqueue(encoded.encode("ore\n\n"));
        controller.close();
      },
    }));
    const frames = [] as Array<{ event: string | null; data: string }>;
    for await (const frame of iterateSse(response, (frame) => {
      seen.push(frame.data);
      frame.data = "after";
    })) frames.push(frame);
    expect(seen).toEqual(["before"]);
    expect(frames).toEqual([{ event: null, data: "after" }]);
  });

  it("出口 lift 确实把完整 frame interceptor 接到解码前", async () => {
    const egress = createChatCompletionsUpstream({ baseUrl: "https://example.invalid/v1", apiKey: "test", model: "test" });
    const source = new Response([
      'data: {"model":"test","choices":[{"delta":{"content":"original"},"finish_reason":null}]}',
      'data: {"model":"test","choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    const events: IREvent[] = [];
    for await (const event of egress.readUpstreamResponse(source, {
      processCompleteSseFrame: (frame) => { frame.data = frame.data.replace("original", "audited"); },
    })) events.push(event);
    expect(events).toContainEqual({ kind: "partDelta", index: 0, delta: { kind: "text", text: "audited" } });
  });
});

describe("统一 inbox completed response interceptor chain", () => {
  const completed: readonly IREvent[] = [
    { kind: "messageStart", model: "gpt-test" },
    { kind: "partStart", index: 0, part: { kind: "text", text: "" } },
    { kind: "partDelta", index: 0, delta: { kind: "text", text: "original" } },
    { kind: "partEnd", index: 0 },
    { kind: "messageStop", reason: "endTurn" },
  ];

  it("流式在终止事件前形成完整 IRResponse，并能修改终止状态", async () => {
    const order: string[] = [];
    const output: IREvent[] = [];
    for await (const event of observeCompleteIRResponseBeforeStreamTermination(eventsOf(completed), "fallback", (response) => {
      order.push(`done:${response.turn.parts.length}`);
      response.stopReason = "maxTokens";
    })) {
      order.push(event.kind);
      output.push(event);
    }
    expect(order).toEqual(["messageStart", "partStart", "partDelta", "partEnd", "done:1", "messageStop"]);
    expect(output.at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
  });

  it("非流式使用同一 IRResponse interceptor，修改后的内容进入 JSON 响应", async () => {
    const response = await writeResponsesResponse(eventsOf(completed), baseRequest, {
      messageId: "response_callback_test",
      processCompleteIRResponse: (document) => {
        const first = document.turn.parts[0];
        if (first?.kind === "text") first.text = "audited";
      },
    });
    expect(JSON.stringify(await (response as Response).json())).toContain("audited");
  });

  it("三个 Inbox 的流式 encoder 都在各自 done 前调用同一个 response interceptor", async () => {
    const writers = [
      { protocol: "anthropic_messages" as const, write: writeAnthropicResponse },
      { protocol: "openai_responses" as const, write: writeResponsesResponse },
      { protocol: "openai_chat_completions" as const, write: writeChatCompletionsResponse },
    ];
    for (const { protocol, write } of writers) {
      let calls = 0;
      const request: IRRequest = {
        ...baseRequest, protocol,
        intent: { ...baseRequest.intent, stream: defaultValue(true) },
      };
      const response = write(eventsOf(completed), request, {
        messageId: `stream_done_${protocol}`,
        processCompleteIRResponse: (document) => {
          calls += 1;
          expect(document.turn.parts).toHaveLength(1);
        },
      });
      await (await response).text();
      expect({ protocol, calls }).toEqual({ protocol, calls: 1 });
    }
  });
});
