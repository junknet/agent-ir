/** 三个 ingress 共用的原语。任何解析歧义都在这里裁决一次，不许各入口各写一套。 */
import type {
  IRBlob, IRCacheBreakpoint, IRLoss, IRPart, IRProtocol, IRSessionIdentity, IRTurn,
} from "../ir/types.ts";

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
 * 202 次并行），不合并就会在 lower 回 Anthropic 时变成多条 user 消息，被判成「漏了结果」。
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
 *    少了这一步，IR 里会留下相邻同角色回合，lower 回 Anthropic 就是连续两条 user 消息。
 *
 * 出参不变量：不存在相邻同角色回合，且没有空回合。
 */
export function normalizeTurns(turns: readonly IRTurn[], losses: LossRecorder): IRTurn[] {
  return mergeAdjacentTurns(dropEmptyTurns(mergeAdjacentTurns(turns), losses));
}

/** 空回合会被下游判成非法输入；它们不携带任何语义，在 IR 边界就丢掉并留痕。 */
function dropEmptyTurns(turns: readonly IRTurn[], losses: LossRecorder): IRTurn[] {
  const kept: IRTurn[] = [];
  turns.forEach((turn, index) => {
    const meaningful = turn.parts.filter(
      (part) => !(part.kind === "text" && part.text.length === 0 && part.cacheBreakpoint === undefined),
    );
    if (meaningful.length === 0) {
      losses.record({
        path: `$.conversation.turns[${index}]`,
        kind: "dropped",
        detail: `empty ${turn.role} turn carries no semantics and is rejected by every upstream`,
      });
      return;
    }
    kept.push(meaningful.length === turn.parts.length ? turn : { role: turn.role, parts: meaningful });
  });
  return kept;
}
