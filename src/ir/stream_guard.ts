/**
 * 长流容错。**协议中立**：它只操作 `IREvent`，因此一份实现同时覆盖全部出口 ——
 * 这正是把它放在 IR 层而不是每个 provider 各写一遍的理由。
 *
 * 设计来自两处成熟实现的互补，不是推演：
 *
 * 一、**提交点**（cc_proxy 生产实现）
 *   首个语义产出下发之前叫 precommit：上游出错还能换号重试、还能改状态码。
 *   之后叫 postcommit：字节已经在下游手里，两者都做不到，只能在 200 流里补协议内的
 *   error 事件收尾。所有容错策略都以这条线分叉。
 *
 * 二、**保活必须计时器驱动**（同上，且有隔离对照实验）
 *   Cloudflare 计的是**数据间隔**不是总时长。2026-07 实测：响应头发出后全程静默 150s
 *   → 524，**125.8 秒**被掐，下游拿到纯文本 "error code: 524"；每 30s 补一个空格
 *   → 200，完整跑完 150.056s。长上下文（1.2–1.3 MB 请求体）算 100 秒以上是常态。
 *   关键教训：一旦把心跳挂在数据分支上，上游彻底静默时它就停摆 —— 而那正是它唯一
 *   要顶的场景。所以这里用独立计时器 race，不依赖上游有没有来数据。
 *
 * 三、**重试判定与退避**（官方 openai-go SDK）
 *   `x-should-retry` 头压过状态码；408/409/429/5xx 可重试；`Retry-After(-Ms)` 优先，
 *   否则 `0.5s × 2ⁿ` 封顶 8s 再减去至多 25% 抖动。
 */
import type { IREvent } from "./types.ts";

// ── 提交点 ──────────────────────────────────────────────────────────────────

/**
 * 是否构成「语义产出」。
 *
 * 只有真实内容才算：`partStart` / `partDelta`。`messageStart` 与 `usage` 不算 ——
 * 上游先回一个无内容首帧、随后才在尾帧给出拒绝，是实测存在的形态（windsurf 的
 * permission_denied 就是这样到达的）。把首帧当提交会让这类拒绝永远失去换号机会。
 */
export function isModelContentEvent(event: IREvent): boolean {
  return event.kind === "partStart" || event.kind === "partDelta";
}

// ── 策略 ────────────────────────────────────────────────────────────────────

export interface IRStreamPolicy {
  /** 提交前的总观察预算。超过即判上游无望，换号重试。 */
  readonly precommitTotalMs: number;
  /** 提交前的静默上限。无协议进展达到它就安全换号 —— 此时还没有任何字节下发。 */
  readonly precommitIdleMs: number;
  /**
   * 提交后的静默上限。`null` = **不因模型静默掐流**（生产默认）。
   * 模型在长思考期间静默几十秒是正常的，掐掉它等于把正常请求判死。
   */
  readonly postcommitIdleMs: number | null;
  /** 保活节律。提交前后都按它注入 `heartbeat`。 */
  readonly heartbeatMs: number;
}

/** 生产默认值，取自 cc_proxy 被真实故障标定过的那组。 */
export const DEFAULT_STREAM_POLICY: IRStreamPolicy = {
  precommitTotalMs: 25_000,
  precommitIdleMs: 15_000,
  postcommitIdleMs: null,
  heartbeatMs: 5_000,
};

// ── 守卫 ────────────────────────────────────────────────────────────────────

interface Clock {
  now(): number;
  /** 返回一个在 ms 后 resolve 的 promise；用于测试注入。 */
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
};

/** race 的哨兵。用具名对象而不是 symbol，让 TS 能靠 `=== IDLE` 收窄联合类型。 */
const IDLE = { idle: true } as const;

/**
 * 给事件流套上超时、保活与提交点标记。
 *
 * 产出的流在原有事件之外多两种：
 *   - `committed`  首个语义产出**之前**注入一次，告诉调用方「从此不可换号」
 *   - `heartbeat`  静默达到节律时注入，由 encoder 渲染成各协议的保活帧
 *
 * 判死只发生在**提交之前**：超总预算或超静默上限 → yield 一条 retryable 的 transport
 * error 并结束。提交之后永不主动掐流，只发心跳（见文件头的生产实测）。
 */
export async function* superviseUpstreamStream(
  source: AsyncIterable<IREvent>,
  policy: IRStreamPolicy = DEFAULT_STREAM_POLICY,
  clock: Clock = REAL_CLOCK,
): AsyncGenerator<IREvent> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = clock.now();
  let lastProgressAt = startedAt;
  let committed = false;

  const fail = (message: string): IREvent => ({
    kind: "error",
    error: { kind: "transport", httpStatus: null, message, retryable: true, raw: null },
  });

  try {
    for (;;) {
      const idleBudget = committed
        ? policy.postcommitIdleMs
        : Math.min(
            policy.precommitIdleMs,
            // 总预算也折成一次等待，两者谁先到谁生效，不必单开一个定时器。
            Math.max(0, policy.precommitTotalMs - (clock.now() - startedAt)),
          );
      // 心跳节律永远参与竞速：它是唯一在上游彻底静默时还会醒来的东西。
      const waitMs = idleBudget === null
        ? policy.heartbeatMs
        : Math.min(policy.heartbeatMs, idleBudget);

      const winner = await Promise.race([
        iterator.next(),
        clock.sleep(waitMs).then((): typeof IDLE => IDLE),
      ]);

      if ("idle" in winner) {
        const idleFor = clock.now() - lastProgressAt;
        const elapsed = clock.now() - startedAt;
        if (!committed && elapsed >= policy.precommitTotalMs) {
          yield fail(`upstream produced no semantic output within ${policy.precommitTotalMs}ms`);
          return;
        }
        if (!committed && idleFor >= policy.precommitIdleMs) {
          yield fail(`upstream stalled for ${policy.precommitIdleMs}ms before any semantic output`);
          return;
        }
        if (committed && policy.postcommitIdleMs !== null && idleFor >= policy.postcommitIdleMs) {
          yield fail(`upstream stalled for ${policy.postcommitIdleMs}ms after commit`);
          return;
        }
        // 还没到判死线：发一发保活，继续等。
        yield { kind: "heartbeat" };
        continue;
      }

      if (winner.done === true) return;
      const event = winner.value;
      lastProgressAt = clock.now();

      if (!committed && isModelContentEvent(event)) {
        committed = true;
        yield { kind: "committed" };
      }
      yield event;
    }
  } finally {
    // 提前退出（下游取消、判死）时要把上游迭代器关掉，否则连接泄漏。
    //
    // **但绝不能 await 它**：上游若卡在不可取消的等待里，`return()` 同样不会 resolve，
    // 一 await 就把整条清理路径一起吊死 —— 症状是下游连接永远不释放。
    // 我们能保证的只是「发出了关闭意图」；真正的套接字回收由响应消费方负责。
    void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
  }
}

// ── 重试判定与退避（对齐官方 openai-go SDK） ───────────────────────────────

/**
 * 该不该重试这次**请求**。
 *
 * 注意与流内判死的区别：这里判的是「还没拿到响应体」的阶段。一旦流已提交，
 * 无论这个函数说什么都不能重试 —— 字节已经在下游手里了。
 */
export function isRetryableResponse(status: number, headers?: Headers): boolean {
  // 上游显式表态压过状态码：它比我们更清楚这次失败是不是暂时的。
  const explicit = headers?.get("x-should-retry");
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * 退避时长。`Retry-After` / `Retry-After-Ms` 优先；否则 `0.5s × 2ⁿ` 封顶 8s，
 * 再减去至多 25% 抖动（避免同时失败的请求整齐重试打成尖峰）。
 */
export function retryDelayMs(
  attempt: number,
  headers?: Headers,
  random: () => number = Math.random,
): number {
  const afterMs = headers?.get("retry-after-ms");
  if (afterMs !== null && afterMs !== undefined) {
    const parsed = Number(afterMs);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  const after = headers?.get("retry-after");
  if (after !== null && after !== undefined) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const base = Math.min(8_000, 500 * 2 ** Math.max(0, attempt));
  return base - Math.floor(random() * (base / 4));
}
