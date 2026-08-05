/**
 * Connect 应用错误 → `IROutboxError`。
 *
 * ══ 这个文件对应一次真实生产故障，值得把因果写全 ══
 *
 * Connect 的流式响应里，**应用错误不在 HTTP 状态码上**：传输层永远是 `200 OK`，
 * 错误住在结束帧的 JSON trailer 里：
 *
 *     {"error":{"code":"permission_denied","message":"an internal error occurred"}}
 *
 * 生产上这条被当成「未知协议错误」落进资源重试路径：换一个账号重发 → 同一条请求
 * 被上游以同样的理由再拒一次 → 打遍整个账号池 → 池子空了之后以 `503 pool_exhausted`
 * 回给客户端。客户端看到的是「上游过载」，于是继续退避重试，而真实原因是**这条请求本身**
 * 永远不会被接受。一次拒绝被放大成 N 次上游调用 + 一个假的过载信号。
 *
 * ⚠ 这里刻意**不写**上游为什么拒。早先的注释断言原因是「内容策略分类器按关键词密度判」，
 * 那条断言已被 `test/fixtures/windsurf_capture/` 的 12 条真实报文证伪：20945–21599 字符的
 * agent 系统提示词 + 23 个工具定义，12/12 条得到 200。**故障与修复都是真的，被证伪的只是
 * 那条推测出来的原因。** 分类判据不依赖它：`permission_denied` 描述的是本次请求被拒，
 * 至于上游按什么判，本模块不知道，也不该假装知道。
 *
 * 修复的判据只有一条：`permission_denied` 描述的是**本次请求**，不是凭据、不是容量。
 * 换账号重试对它没有任何意义 → `retryable: false`。
 * 对照生产 `packages/relay_core/src/messages_failure_policy.ts`：命中即
 * `retry:"none", credential:"unchanged"`；`upstream_application_error.ts` 再把它
 * 恢复成下游可处置的 HTTP 403。
 *
 * ── 一处 IR 表达不了的东西（报告里点名）──────────────────────────────────
 * `unauthenticated`（会话失效）与 `permission_denied`（本次请求被拒）在 IR 里都只能是
 * `permissionDenied`，而 `retryable` 是**单个布尔**：它回答不了「换个凭据重试有没有用」。
 * 前者换号必成、后者换号必败，两者在这里被迫共享同一个判别位。本文件对二者都取
 * `retryable:false`（保守：绝不把一次拒绝放大成打遍账号池），代价是会话失效时也不会自动换号。
 */
import type { IROutboxError } from "../../ir/types.ts";

/**
 * gRPC 数字码 → Connect 字符串码。
 *
 * Connect over HTTP 的 trailer 用字符串码，但同一套服务的其它信号面（生产
 * `windsurf_protocol/src/account.ts` 的 `connect_rpc` 信号）实测出现过数字码，
 * 且 gRPC-Web 网关回落时也会给数字。两种都认，不猜。
 */
const GRPC_CODE_NAMES: Readonly<Record<number, string>> = {
  1: "canceled", 2: "unknown", 3: "invalid_argument", 4: "deadline_exceeded",
  5: "not_found", 6: "already_exists", 7: "permission_denied", 8: "resource_exhausted",
  9: "failed_precondition", 10: "aborted", 11: "out_of_range", 12: "unimplemented",
  13: "internal", 14: "unavailable", 15: "data_loss", 16: "unauthenticated",
};

export function normalizeConnectCode(code: unknown): string | null {
  if (typeof code === "number" && Number.isInteger(code)) return GRPC_CODE_NAMES[code] ?? null;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;
  // 数字串（"7"）与 SCREAMING_SNAKE（"PERMISSION_DENIED"）都归一到 Connect 的小写蛇形。
  if (/^\d+$/u.test(trimmed)) return GRPC_CODE_NAMES[Number(trimmed)] ?? null;
  return trimmed.toLowerCase().replace(/[\s-]+/gu, "_");
}

/**
 * Connect code → IR 错误种类。
 *
 * 分档依据（生产实证，见文件头）：
 *   永久拒绝 —— `permission_denied` / `unauthenticated`：换号、退避都无用。
 *   瞬时故障 —— `unavailable` / `internal` / `unknown` / `deadline_exceeded` / `aborted`：
 *               对应生产 `TRANSIENT_CONNECT_CODES`（含数字码 2/4/13/14），重试有意义。
 *   请求有病 —— `invalid_argument` 等：生产实测形态
 *               `stream error: {"code":"invalid_argument","message":"..."}`，重试必然重演。
 */
const CONNECT_CODE_KIND: Readonly<Record<string, IROutboxError["kind"]>> = {
  // ── 永久：本次请求或本凭据被拒 ────────────────────────────────────────
  permission_denied: "permissionDenied",
  unauthenticated: "permissionDenied",
  // ── 容量 ──────────────────────────────────────────────────────────────
  resource_exhausted: "rateLimited",
  // ── 瞬时 ──────────────────────────────────────────────────────────────
  unavailable: "outboxUnavailable",
  internal: "outboxUnavailable",
  unknown: "outboxUnavailable",
  deadline_exceeded: "outboxUnavailable",
  aborted: "outboxUnavailable",
  // ── 传输 ──────────────────────────────────────────────────────────────
  canceled: "transport",
  // ── 请求本身 ──────────────────────────────────────────────────────────
  invalid_argument: "invalidRequest",
  failed_precondition: "invalidRequest",
  out_of_range: "invalidRequest",
  not_found: "invalidRequest",
  already_exists: "invalidRequest",
  unimplemented: "invalidRequest",
  data_loss: "invalidRequest",
};

/**
 * 只有这三档重试才有意义。
 *
 * `permissionDenied` **不在**里面 —— 这正是本文件存在的理由。
 * `quotaExhausted` 也不在：配额耗尽是账号的状态，重发同一请求只会再撞一次
 * （换账号是调用方的调度决定，不是「这条错误可重试」）。
 */
const RETRYABLE_KINDS: ReadonlySet<IROutboxError["kind"]> = new Set([
  "rateLimited", "outboxUnavailable", "transport",
]);

/**
 * `resource_exhausted` 的两种含义：限流（等一会儿就好）与配额耗尽（今天没了）。
 * Connect code 不区分，只能看文案。命中配额词才降级成 `quotaExhausted`。
 */
const QUOTA_PATTERN = /quota|credit|balance|exhaust|out of (credits?|tokens?)/iu;
const CONTEXT_LENGTH_PATTERN =
  /context (length|window)|too many tokens|maximum context|prompt is too long|input is too long|token limit/iu;

export interface ConnectErrorPayload {
  readonly code: string | null;
  readonly message: string | null;
  readonly raw: unknown;
}

/**
 * 从 trailer 里摘出 `{code, message}`。
 *
 * Connect 的形状是 `{"error":{"code","message","details"}}`，但同一条链路上也见过
 * 顶层直接给 `{code,message}` 的（生产 `parseUpstreamApplicationError` 为此做了嵌套探测）。
 * 两层都看，取先命中的。
 */
export function readConnectError(trailer: Record<string, unknown>): ConnectErrorPayload | null {
  const holder = trailer.error;
  const source: Record<string, unknown> | null =
    typeof holder === "object" && holder !== null && !Array.isArray(holder)
      ? holder as Record<string, unknown>
      : typeof trailer.code === "string" || typeof trailer.code === "number"
        ? trailer
        : null;
  if (source === null) {
    // `{"error":"something went wrong"}`：字符串错误也是错误，不能当干净收尾。
    if (typeof holder === "string" && holder.trim().length > 0) {
      return { code: null, message: holder, raw: trailer };
    }
    return null;
  }
  const code = normalizeConnectCode(source.code);
  const message = typeof source.message === "string" ? source.message : null;
  if (code === null && message === null) return null;
  return { code, message, raw: trailer };
}

/** Connect 应用错误 → IR。`httpStatus` 恒为 null：传输层给的是 200，这是本出口的核心特性。 */
export function mapConnectError(payload: ConnectErrorPayload): IROutboxError {
  const message = payload.message ?? payload.code ?? "windsurf upstream error";
  let kind: IROutboxError["kind"] =
    payload.code === null ? "unknown" : CONNECT_CODE_KIND[payload.code] ?? "unknown";
  if (kind === "rateLimited" && QUOTA_PATTERN.test(message)) kind = "quotaExhausted";
  if (kind === "invalidRequest" && CONTEXT_LENGTH_PATTERN.test(message)) kind = "contextLengthExceeded";
  return {
    kind,
    // 上游 HTTP 是 200 —— 应用错误全在 Connect 尾帧里。填一个想象出来的 403 会让
    // 「上游到底回了什么」这条链路从此不可信；下游状态码由 encoder 从 kind 推。
    httpStatus: null,
    message,
    retryable: RETRYABLE_KINDS.has(kind),
    raw: payload.raw,
  };
}

/**
 * HTTP 层错误（非 200）。Connect 的鉴权/路由失败仍会走真正的状态码，
 * 与尾帧错误是**两条**路径，不能合并处理。
 */
export function mapHttpError(status: number, bodyText: string): IROutboxError {
  const trimmed = bodyText.trim();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Connect 的 HTTP 层错误体不保证是 JSON；状态码本身已经够判档。
  }
  const embedded = parsed === null ? null : readConnectError(parsed);
  const kind: IROutboxError["kind"] = (() => {
    if (embedded?.code !== null && embedded?.code !== undefined) {
      return CONNECT_CODE_KIND[embedded.code] ?? httpStatusKind(status);
    }
    return httpStatusKind(status);
  })();
  const message = embedded?.message ?? (trimmed.length === 0 ? `HTTP ${status}` : trimmed.slice(0, 2000));
  return {
    kind,
    httpStatus: status,
    message,
    retryable: RETRYABLE_KINDS.has(kind),
    raw: parsed ?? bodyText,
  };
}

function httpStatusKind(status: number): IROutboxError["kind"] {
  if (status === 401 || status === 403) return "permissionDenied";
  if (status === 429) return "rateLimited";
  if (status === 402) return "quotaExhausted";
  if (status === 413) return "invalidRequest";
  if (status >= 500) return "outboxUnavailable";
  if (status >= 400) return "invalidRequest";
  return "unknown";
}
