import { describe, expect, it } from "bun:test";
import { writeResponsesResponse } from "../src/ingress/openai_encode.ts";
import { defaultValue, type IREvent, type IRRequest } from "../src/ir/types.ts";

async function* streamOf(events: readonly IREvent[]): AsyncGenerator<IREvent> {
  for (const event of events) yield event;
}

const request: IRRequest = {
  traceId: "encode-test",
  protocol: "openai_responses",
  model: "gpt-test",
  conversation: { system: [], turns: [], toolset: { tools: [], groups: [], choice: defaultValue({ kind: "auto" }), parallel: defaultValue(true) } },
  intent: {
    reasoning: defaultValue({ mode: "auto", display: "summarized" }), outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"), sampling: {}, stopping: {}, contextEdits: [], stream: defaultValue(true), identity: {},
  },
  requires: [],
};

describe("Responses 流式 encoder", () => {
  it("在 completed 之前完整发送函数调用生命周期", async () => {
    const response = writeResponsesResponse(streamOf([
      { kind: "messageStart", model: "gpt-test" },
      { kind: "partStart", index: 7, part: { kind: "toolCall", call: { id: "call_weather", toolRef: { group: "weather", name: "get" }, input: { kind: "json", value: {} } } } },
      { kind: "partDelta", index: 7, delta: { kind: "toolInputJson", json: '{"city":' } },
      { kind: "partDelta", index: 7, delta: { kind: "toolInputJson", json: '"Shanghai"}' } },
      { kind: "partEnd", index: 7 },
      { kind: "messageStop", reason: "toolUse" },
    ]), request, { messageId: "resp_test" });
    const body = await (response as Response).text();

    expect(body).toContain("event: response.output_item.added");
    expect(body).toContain("event: response.function_call_arguments.delta");
    expect(body).toContain("event: response.function_call_arguments.done");
    expect(body).toContain("event: response.output_item.done");
    expect(body.indexOf("event: response.output_item.done")).toBeLessThan(body.indexOf("event: response.completed"));
    expect(body).toContain('"namespace":"weather"');
    expect(body).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
  });
});
