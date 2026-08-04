/** 三个 ingress 共用的原语。任何解析歧义都在这里裁决一次，不许各入口各写一套。 */
import { IR_EFFORTS } from "../ir/types.ts";
import type {
  IRBlob, IRCacheBreakpoint, IREffort, IRLoss, IRPart, IRProtocol, IRSessionIdentity,
  IRToolChoice, IRTurn,
} from "../ir/types.ts";

/** 出站编码的共用参数。两个 encoder 都要，放这里避免它们互相 import。 */
export interface EncodeOptions {
  readonly messageId: string;
  /** 未识别的上游事件计数回调；网关据此发现协议漂移。 */
  readonly onUnhandled?: (rawType: string, raw: unknown) => void;
}

export class LossRecorder {
  readonly #losses: IRLoss[] = [];

  record(loss: Omit<IRLoss, "stage" | "provider">): void {
    this.#losses.push({ stage: "ingress", provider: null, ...loss });
  }

  drain(): readonly IRLoss[] {
    return [...this.#losses];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 档位取值三个协议一致（Anthropic 走 output_config.effort，OpenAI 走 reasoning[_effort]）。
 *
 * 校验清单直接用 `IR_EFFORTS`：这里原先手抄了一份档位数组，抄漏一档不会有任何编译错误，
 * 只会让客户端明确要求的 effort 静默变成 undefined。
 */
export function parseEffort(value: unknown): IREffort | undefined {
  const raw = asString(value);
  return raw !== null && (IR_EFFORTS as readonly string[]).includes(raw) ? (raw as IREffort) : undefined;
}

/**
 * OpenAI 两个协议共用的 tool_choice 字符串档。
 * Anthropic 不走这里：它用 `{type:'any'}` 表达 required，是另一套 wire 词汇。
 */
export function parseStringToolChoice(value: string): IRToolChoice | null {
  if (value === "auto") return { kind: "auto" };
  if (value === "none") return { kind: "none" };
  if (value === "required") return { kind: "required" };
  return null;
}

/**
 * Anthropic `cache_control` → IR 缓存断点。语料里只见过 `{type:'ephemeral'}`，
 * 但 ttl 变体已在 wire 上出现过，所以显式解析而不是硬编码。
 */
export function parseCacheBreakpoint(value: unknown): IRCacheBreakpoint | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "ephemeral") return undefined;
  const ttl = asString(value.ttl);
  if (ttl === null) return { scope: "ephemeral" };
  const seconds = /^(\d+)([smh])$/u.exec(ttl);
  if (seconds === null) return { scope: "ephemeral" };
  const amount = Number(seconds[1]);
  const unit = seconds[2];
  const multiplier = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return { scope: "ephemeral", ttlSeconds: amount * multiplier };
}

/** data URL / 裸 base64 / http(s) URL 三种图片载体归一。三个入口的图片形状全落在这里。 */
export function parseImageBlob(input: {
  readonly url?: unknown;
  readonly base64?: unknown;
  readonly mediaType?: unknown;
}): IRBlob | null {
  const declaredMediaType = asString(input.mediaType);
  const base64 = asString(input.base64);
  if (base64 !== null) {
    return {
      source: { kind: "base64", data: base64 },
      mediaType: declaredMediaType ?? "application/octet-stream",
      bytes: Math.floor((base64.length * 3) / 4),
    };
  }
  const url = asString(input.url);
  if (url === null) return null;
  const dataUrl = /^data:([^;,]+)(;base64)?,(.*)$/su.exec(url);
  if (dataUrl !== null && dataUrl[2] !== undefined) {
    const data = dataUrl[3] ?? "";
    return {
      source: { kind: "base64", data },
      mediaType: dataUrl[1] ?? declaredMediaType ?? "application/octet-stream",
      bytes: Math.floor((data.length * 3) / 4),
    };
  }
  return { source: { kind: "url", url }, mediaType: declaredMediaType ?? "application/octet-stream" };
}

export function opaquePart(origin: IRProtocol, tag: string, raw: unknown): IRPart {
  return { kind: "opaque", origin, tag, raw };
}

export function textPart(text: string, cacheBreakpoint?: IRCacheBreakpoint): IRPart {
  return cacheBreakpoint === undefined ? { kind: "text", text } : { kind: "text", text, cacheBreakpoint };
}

/**
 * Claude Code 把会话身份塞进 `metadata.user_id` 的 JSON 字符串里（语料 365 次）。
 * 解析失败不是错误：非 Claude Code 客户端的 user_id 就是普通字符串。
 */
export function parseSessionIdentity(metadata: unknown): IRSessionIdentity {
  if (!isRecord(metadata)) return {};
  const userId = asString(metadata.user_id);
  if (userId === null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(userId); } catch { return {}; }
  if (!isRecord(parsed)) return {};
  const sessionId = asString(parsed.session_id);
  const deviceId = asString(parsed.device_id);
  const accountUuid = asString(parsed.account_uuid);
  return {
    ...(sessionId !== null && sessionId.length > 0 ? { sessionId } : {}),
    ...(deviceId !== null && deviceId.length > 0 ? { deviceId } : {}),
    ...(accountUuid !== null && accountUuid.length > 0 ? { accountUuid } : {}),
  };
}

/**
 * 合并相邻同角色回合。
 *
 * OpenAI 侧一次并行工具调用会产生连续多条 `role:'tool'` 消息（语料 2355 条 tool 消息 /
 * 202 次并行），不合并就会在 写出到 Anthropic 时变成多条 user 消息，被判成「漏了结果」。
 * 合并放在 IR 构建的最后一步，三个入口共用，不在各自 decode 里各修一次。
 */
export function mergeAdjacentTurns(turns: readonly IRTurn[]): IRTurn[] {
  const merged: IRTurn[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === turn.role) {
      merged[merged.length - 1] = { role: previous.role, parts: [...previous.parts, ...turn.parts] };
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

/**
 * 回合序列的唯一归一入口：合并 → 丢空 → 再合并。
 *
 * 顺序不是随便定的：
 *  - 先合并，让「空回合紧邻同角色回合」被无损吸收，不产生假的 loss；
 *  - 再丢掉真正孤立的空回合（它们被每个上游拒收）；
 *  - **必须再合并一次**：丢掉中间那个异角色空回合后，两侧会变成相邻同角色。
 *    少了这一步，IR 里会留下相邻同角色回合，写出到 Anthropic 就是连续两条 user 消息。
 *
 * 出参不变量：不存在相邻同角色回合，且没有空回合。
 */
export function normalizeTurns(turns: readonly IRTurn[]): IRTurn[] {
  // 只合并，不丢空。**丢空回合是策略不是解码事实** —— 它已剥离到 repair 层的
  // `dropEmptyTurn`，由调用方显式选择；Core 把空回合原样交给 egress，
  // 由各 wire 按自己的编译事实处置。
  //
  // 为什么不需要「丢空之后再合并一次」：合并的出参恒不含相邻同角色（每个回合
  // 要么折进上一条、要么角色与上一条不同，是循环不变量），一次即不动点。
  // 原先那第二次合并只为修复丢空造成的新相邻，不丢空就没有可修的东西。
  return mergeAdjacentTurns(turns);
}

