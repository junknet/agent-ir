/**
 * 长流容错。
 *
 * 策略不是推演出来的：提交点与三档预算取自 cc_proxy 被真实故障标定过的生产实现，
 * 重试判定与退避对齐官方 openai-go SDK。这组用例把两边的结论锁成断言。
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STREAM_POLICY, superviseUpstreamStream, isRetryableResponse, isModelContentEvent, retryDelayMs,
} from "../src/ir/stream_guard.ts";
// 生产默认值本身也是契约的一部分：改动它等于改动被真实故障标定过的那组预算。
import type { IREvent } from "../src/ir/types.ts";

/** 永不产出的上游 —— 模拟彻底静默。 */
function silentSource(): AsyncIterable<IREvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
}

async function* sourceOf(events: readonly IREvent[]): AsyncGenerator<IREvent> {
  for (const event of events) yield event;
}

async function drain(stream: AsyncIterable<IREvent>, limit = 200): Promise<IREvent[]> {
  const out: IREvent[] = [];
  for await (const event of stream) {
    out.push(event);
    if (out.length >= limit) break;
  }
  return out;
}

describe("提交点", () => {
  it("只有真实内容算语义产出 —— messageStart / usage 不算", () => {
    expect(isModelContentEvent({ kind: "partStart", index: 0, part: { kind: "text", text: "" } })).toBe(true);
    expect(isModelContentEvent({ kind: "partDelta", index: 0, delta: { kind: "text", text: "x" } })).toBe(true);
    // 上游先回无内容首帧、随后在尾帧拒绝，是实测存在的形态（windsurf 的 permission_denied）。
    // 把首帧当提交，这类拒绝就永远失去换号机会。
    expect(isModelContentEvent({ kind: "messageStart", model: "m" })).toBe(false);
    expect(isModelContentEvent({ kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } })).toBe(false);
  });

  it("首个语义产出之前注入一次 committed，且只注入一次", async () => {
    const events = await drain(superviseUpstreamStream(sourceOf([
      { kind: "messageStart", model: "m" },
      { kind: "partStart", index: 0, part: { kind: "text", text: "" } },
      { kind: "partDelta", index: 0, delta: { kind: "text", text: "hi" } },
      { kind: "messageStop", reason: "endTurn" },
    ])));
    expect(events.map((e) => e.kind))
      .toEqual(["messageStart", "committed", "partStart", "partDelta", "messageStop"]);
  });
});

describe("提交前判死（此时还没有字节下发，换号是安全的）", () => {
  it("静默达到 precommitIdleMs → 可重试的 transport error", async () => {
    // 用毫秒级预算跑真实计时器：比例与生产一致（心跳 : 判死 = 1 : 3）。
    const collected = await drain(superviseUpstreamStream(silentSource(), {
      precommitTotalMs: 300, precommitIdleMs: 30, postcommitIdleMs: null, heartbeatMs: 10,
    }));
    // 10ms / 20ms 各一次心跳，30ms 到线判死
    expect(collected.map((e) => e.kind)).toEqual(["heartbeat", "heartbeat", "error"]);
    const failure = collected[2];
    expect(failure?.kind === "error" && failure.error.retryable).toBe(true);
    expect(failure?.kind === "error" && failure.error.kind).toBe("transport");
  });

  it("总预算先到时同样判死（模型一直在挤心跳但从不产出）", async () => {
    const collected = await drain(superviseUpstreamStream(silentSource(), {
      precommitTotalMs: 25, precommitIdleMs: 10_000, postcommitIdleMs: null, heartbeatMs: 10,
    }));
    expect(collected[collected.length - 1]?.kind).toBe("error");
    expect(collected.filter((e) => e.kind === "heartbeat").length).toBeGreaterThanOrEqual(1);
  });
});

describe("提交后永不主动掐流", () => {
  it("默认策略下静默再久也只发心跳 —— 模型长思考几十秒是正常的", async () => {
    async function* committedThenSilent(): AsyncGenerator<IREvent> {
      yield { kind: "partDelta", index: 0, delta: { kind: "text", text: "start" } };
      await new Promise<never>(() => {});
    }
    // precommit 预算故意设得极短：提交之后它们必须全部失效，否则这条会在 5ms 判死。
    const collected = await drain(superviseUpstreamStream(committedThenSilent(), {
      precommitTotalMs: 5, precommitIdleMs: 5, postcommitIdleMs: null, heartbeatMs: 10,
    }), 12);
    expect(collected.slice(0, 2).map((e) => e.kind)).toEqual(["committed", "partDelta"]);
    // 其余全是心跳，一条 error 都没有
    expect(collected.slice(2).every((e) => e.kind === "heartbeat")).toBe(true);
    expect(collected.some((e) => e.kind === "error")).toBe(false);
  });

  it("显式设了 postcommitIdleMs 时，提交后也会判死", async () => {
    async function* committedThenSilent(): AsyncGenerator<IREvent> {
      yield { kind: "partDelta", index: 0, delta: { kind: "text", text: "start" } };
      await new Promise<never>(() => {});
    }
    const collected = await drain(superviseUpstreamStream(committedThenSilent(), {
      precommitTotalMs: 10_000, precommitIdleMs: 10_000, postcommitIdleMs: 30, heartbeatMs: 10,
    }));
    expect(collected[collected.length - 1]?.kind).toBe("error");
  });
});

describe("心跳必须计时器驱动", () => {
  it("上游彻底静默时心跳照发 —— 这正是它唯一要顶的场景", async () => {
    const collected = await drain(superviseUpstreamStream(silentSource(), {
      precommitTotalMs: 10_000, precommitIdleMs: 10_000, postcommitIdleMs: null, heartbeatMs: 5,
    }), 4);
    expect(collected.every((e) => e.kind === "heartbeat")).toBe(true);
    expect(collected).toHaveLength(4);
  });
});

describe("生产默认预算", () => {
  it("与 cc_proxy 被真实故障标定过的那组一致 —— 改这里等于改容错行为", () => {
    expect(DEFAULT_STREAM_POLICY).toEqual({
      precommitTotalMs: 25_000,   // 提交前最多观察 25s
      precommitIdleMs: 15_000,    // 15s 无协议进展即安全换号
      postcommitIdleMs: null,     // 提交后不因模型静默掐流
      heartbeatMs: 5_000,         // 保活节律，远小于 CF 实测的 125.8s 掐断线
    });
  });
});

describe("重试判定（对齐官方 openai-go SDK）", () => {
  it("x-should-retry 头压过状态码", () => {
    expect(isRetryableResponse(400, new Headers({ "x-should-retry": "true" }))).toBe(true);
    expect(isRetryableResponse(500, new Headers({ "x-should-retry": "false" }))).toBe(false);
  });

  it("408 / 409 / 429 / 5xx 可重试，其余不可", () => {
    for (const status of [408, 409, 429, 500, 502, 503]) expect(isRetryableResponse(status)).toBe(true);
    for (const status of [200, 400, 401, 403, 404, 422]) expect(isRetryableResponse(status)).toBe(false);
  });
});

describe("退避（对齐官方 openai-go SDK）", () => {
  it("Retry-After-Ms 优先于一切", () => {
    expect(retryDelayMs(5, new Headers({ "retry-after-ms": "250" }))).toBe(250);
  });

  it("Retry-After 秒数与 HTTP 日期都认", () => {
    expect(retryDelayMs(0, new Headers({ "retry-after": "3" }))).toBe(3000);
    const at = new Date(Date.now() + 2000).toUTCString();
    expect(retryDelayMs(0, new Headers({ "retry-after": at }))).toBeGreaterThan(500);
  });

  it("无头时 0.5s×2ⁿ 封顶 8s，并减去至多 25% 抖动", () => {
    // random=0 → 无抖动，取上界
    expect(retryDelayMs(0, undefined, () => 0)).toBe(500);
    expect(retryDelayMs(1, undefined, () => 0)).toBe(1000);
    expect(retryDelayMs(4, undefined, () => 0)).toBe(8000);
    expect(retryDelayMs(9, undefined, () => 0)).toBe(8000);
    // random≈1 → 抖动拉满，恰好是 base 的 75%
    expect(retryDelayMs(4, undefined, () => 0.999)).toBeGreaterThanOrEqual(6000);
    expect(retryDelayMs(4, undefined, () => 0.999)).toBeLessThan(8000);
  });
});
