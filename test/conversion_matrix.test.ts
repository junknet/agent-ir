/**
 * 三入口 × 三目标的实际编译矩阵。
 *
 * `codec_coverage` 锁注册表完整性；本测试再锁行为：每个真实入口形状都必须先
 * decode 成同一种 IR，随后能被 Anthropic、标准 Responses（Codex 语义）与
 * Windsurf Connect 三个目标 independently lower。全程不发网络请求。
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicOutbox } from "../src/outbox/anthropic.ts";
import { createOpenAIResponsesOutbox } from "../src/outbox/openai_responses.ts";
import { createWindsurfOutbox } from "../src/outbox/windsurf/index.ts";
import { checkOutboxSupport } from "../src/ir/admission.ts";
import { INBOX_CODECS } from "../src/protocols.ts";
import { IR_PROTOCOLS, type IRProtocol, type IROutbox } from "../src/ir/types.ts";

const samples: Record<IRProtocol, unknown> = {
  anthropic_messages: {
    model: "test-model", max_tokens: 32, stream: true,
    system: "Return the marker.", messages: [{ role: "user", content: "ping" }],
  },
  openai_chat_completions: {
    model: "test-model", max_completion_tokens: 32, stream: true,
    messages: [
      { role: "system", content: "Return the marker." },
      { role: "user", content: "ping" },
    ],
  },
  openai_responses: {
    model: "test-model", max_output_tokens: 32, stream: true,
    instructions: "Return the marker.", input: "ping",
  },
};

const targets: Record<string, IROutbox<string | Uint8Array>> = {
  anthropic: createAnthropicOutbox({
    baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "claude-test",
  }),
  openai_responses: createOpenAIResponsesOutbox({
    baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "gpt-test",
  }),
  windsurf: createWindsurfOutbox({
    server: "http://127.0.0.1:1", apiKey: "test-key", model: "claude-test",
  }),
};

describe("三入口 × Anthropic / Responses / Windsurf 编译矩阵", () => {
  for (const protocol of IR_PROTOCOLS) {
    for (const [targetName, outbox] of Object.entries(targets)) {
      it(`${protocol} -> ${targetName}`, async () => {
        const { request } = INBOX_CODECS[protocol].readClientRequest(
          samples[protocol], `matrix-${protocol}-${targetName}`,
        );
        const verdict = checkOutboxSupport(request, outbox.profile);
        expect(verdict.admitted).toBe(true);

        const lowered = await outbox.writeOutboxRequest(request);
        expect(lowered.ok).toBe(true);
        if (!lowered.ok) return;
        expect(lowered.wire.method).toBe("POST");
        const bytes = typeof lowered.wire.body === "string"
          ? new TextEncoder().encode(lowered.wire.body).byteLength
          : lowered.wire.body.byteLength;
        expect(bytes).toBeGreaterThan(0);
      });
    }
  }
});
