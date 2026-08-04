/**
 * 分级结构化日志。零依赖，两个落点：stderr（dev 彩色文本 / prod JSON）+ 可选 NDJSON 落盘。
 *
 * 三条来自实测的硬约束：
 *  1. **截断必须发生在字段内部**，不能整条切。agent-all-sdk-ts 的 devlog 曾经对已 stringify
 *     的整条记录裸切片，切点落在转义序列中间就产出非法 JSON，下游全解析失败；后来改成把半截
 *     原文当普通字符串重新 stringify，外层合法了但 trace/phase 之后的字段全丢。这里改成逐字段
 *     裁剪：结构永远完整，只有超长的**值**被替换成 `<truncated:N>`。
 *  2. **敏感字段按名字兜底脱敏**，不靠调用方自觉。
 *  3. **级别是唯一开关**，没有第二套 enabled 布尔。dev 默认 debug，prod 默认 info。
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const MAX_DEPTH = 10;
const MAX_ARRAY = 200;
/** 单个字符串值的上限。超过只裁这一个值，记录结构不受影响。 */
const MAX_STRING = 4_000;

const SENSITIVE = new Set([
  "authorization", "proxy_authorization", "cookie", "set_cookie",
  "api_key", "apikey", "x_api_key", "access_token", "refresh_token", "id_token",
  "password", "secret", "session_key", "client_secret",
]);

export interface LogRecord {
  readonly event: string;
  readonly [field: string]: unknown;
}

export interface EmittedLine {
  readonly ts: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly event: string;
  readonly trace: string | null;
  readonly fields: Record<string, unknown>;
  readonly errorMessage?: string;
  readonly errorStack?: string;
}

export type LogSink = (line: EmittedLine) => void;

export interface Logger {
  trace(record: LogRecord): void;
  debug(record: LogRecord): void;
  info(record: LogRecord): void;
  warn(record: LogRecord): void;
  error(record: LogRecord & { error?: unknown }): void;
  /** 绑定固定字段（trace id、protocol、model…），返回同源子 logger。 */
  child(fields: Record<string, unknown>): Logger;
  /** 当前是否会真的输出该级别；用于跳过昂贵的字段构造。 */
  enabled(level: LogLevel): boolean;
}

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly service: string;
  readonly sink: LogSink;
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw.length === 0) return fallback;
  const found = LOG_LEVELS.find((level) => level === raw);
  if (found === undefined) {
    throw new Error(`invalid log level '${raw}'; expected one of ${LOG_LEVELS.join("|")}`);
  }
  return found;
}

// ── sinks ──────────────────────────────────────────────────────────────────

export function jsonSink(write: (text: string) => void = (t) => process.stderr.write(t)): LogSink {
  return (line) => { write(`${JSON.stringify(line)}\n`); };
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  trace: "\x1b[90m", debug: "\x1b[36m", info: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m",
};

export function textSink(options: { colors?: boolean } = {}): LogSink {
  const colors = options.colors ?? Boolean(process.stderr.isTTY);
  return (line) => {
    const color = colors ? LEVEL_COLOR[line.level] : "";
    const reset = colors ? "\x1b[0m" : "";
    const head = `${line.ts} ${line.level.toUpperCase().padEnd(5)} [${line.service}]`;
    const parts = [`event=${line.event}`];
    if (line.trace !== null) parts.push(`trace=${line.trace}`);
    for (const [key, value] of Object.entries(line.fields)) {
      parts.push(`${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`);
    }
    if (line.errorMessage !== undefined) parts.push(`error=${JSON.stringify(line.errorMessage)}`);
    process.stderr.write(`${color}${head} ${parts.join(" ")}${reset}\n`);
  };
}

// ── normalization ──────────────────────────────────────────────────────────

function isSensitive(name: string): boolean {
  return SENSITIVE.has(name.toLowerCase().replaceAll("-", "_"));
}

function normalize(value: unknown, seen: WeakSet<object>, depth: number, name: string | null): unknown {
  if (name !== null && isSensitive(name)) return REDACTED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}<truncated:${value.length - MAX_STRING}>`
      : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value);
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (depth >= MAX_DEPTH) return `<max-depth:${MAX_DEPTH}>`;
  if (seen.has(value as object)) return CIRCULAR;
  seen.add(value as object);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => normalize(item, seen, depth + 1, null));
    if (value.length > MAX_ARRAY) items.push(`<truncated:${value.length - MAX_ARRAY}>`);
    return items;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, normalize(nested, seen, depth + 1, key)]),
  );
}

export function normalizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return normalize(fields, new WeakSet<object>(), 0, null) as Record<string, unknown>;
}

// ── logger ─────────────────────────────────────────────────────────────────

export function createLogger(config: LoggerConfig, base: Record<string, unknown> = {}): Logger {
  const minimum = LEVEL_RANK[config.level];
  const emit = (level: LogLevel, record: LogRecord & { error?: unknown }): void => {
    if (LEVEL_RANK[level] < minimum) return;
    const { event, trace, error, ...rest } = record as Record<string, unknown> & { event: string };
    const merged = { ...base, ...rest };
    const traceId = trace ?? merged.trace ?? null;
    delete merged.trace;
    const line: EmittedLine = {
      ts: new Date().toISOString(),
      level,
      service: config.service,
      event,
      trace: typeof traceId === "string" ? traceId : null,
      fields: normalizeLogFields(merged),
      ...(error === undefined ? {} : {
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && typeof error.stack === "string" ? { errorStack: error.stack } : {}),
      }),
    };
    try { config.sink(line); } catch { /* 同上 */ }
  };
  return {
    trace: (record) => emit("trace", record),
    debug: (record) => emit("debug", record),
    info: (record) => emit("info", record),
    warn: (record) => emit("warn", record),
    error: (record) => emit("error", record),
    child: (fields) => createLogger(config, { ...base, ...fields }),
    enabled: (level) => LEVEL_RANK[level] >= minimum,
  };
}

// ── process-wide root ──────────────────────────────────────────────────────

let root: Logger | null = null;

export function configureLogging(config: LoggerConfig): void {
  root = createLogger(config);
}

export function getLogger(component: string): Logger {
  return {
    trace: (r) => resolveRoot().trace({ ...r, component }),
    debug: (r) => resolveRoot().debug({ ...r, component }),
    info: (r) => resolveRoot().info({ ...r, component }),
    warn: (r) => resolveRoot().warn({ ...r, component }),
    error: (r) => resolveRoot().error({ ...r, component }),
    child: (fields) => resolveRoot().child({ component, ...fields }),
    enabled: (level) => resolveRoot().enabled(level),
  };
}

function resolveRoot(): Logger {
  if (root === null) {
    const dev = (process.env.AGENT_IR_ENV ?? "dev") === "dev";
    root = createLogger({
      level: parseLogLevel(process.env.AGENT_IR_LOG_LEVEL, dev ? "debug" : "info"),
      service: process.env.AGENT_IR_SERVICE ?? "agent-ir",
      sink: (process.env.AGENT_IR_LOG_FORMAT ?? (dev ? "text" : "json")) === "text" ? textSink() : jsonSink(),
    });
  }
  return root;
}
