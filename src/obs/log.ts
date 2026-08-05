/** Pino 日志装配：等级、脱敏和输出格式均使用 Pino 的标准契约。 */
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import pinoPretty from "pino-pretty";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "text" | "json";
/** 日志调用方直接依赖成熟库的公共契约。 */
export type Logger = PinoLogger;

export interface LoggingSettings {
  readonly level: LogLevel;
  readonly service: string;
  readonly format: LogFormat;
}

const SENSITIVE_FIELD_NAMES = [
  "authorization", "proxy_authorization", "cookie", "set_cookie",
  "api_key", "apikey", "x_api_key", "access_token", "refresh_token", "id_token",
  "password", "secret", "session_key", "client_secret",
] as const;
const MAX_SENSITIVE_FIELD_DEPTH = 10;

function createSensitiveFieldPaths(): string[] {
  return SENSITIVE_FIELD_NAMES.flatMap((name) => {
    const hyphenated = name.replaceAll("_", "-");
    return Array.from({ length: MAX_SENSITIVE_FIELD_DEPTH + 1 }, (_, depth) => {
      const prefix = "*.".repeat(depth);
      return [
        `${prefix}${name}`,
        ...(hyphenated === name ? [] : [`${prefix}[\"${hyphenated}\"]`]),
      ];
    }).flat();
  });
}

export function parseLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw.length === 0) return fallback;
  const found = LOG_LEVELS.find((level) => level === raw);
  if (found === undefined) {
    throw new Error(`invalid log level '${raw}'; expected one of ${LOG_LEVELS.join("|")}`);
  }
  return found;
}

function createLogDestination(format: LogFormat): DestinationStream {
  if (format === "json") return pino.destination({ dest: 2, sync: false });
  return pinoPretty({
    colorize: Boolean(process.stderr.isTTY),
    destination: 2,
    singleLine: true,
    sync: true,
  });
}

/** 构造完成即是可用的 Pino 实例；测试可注入写入目标，不依赖进程全局状态。 */
export function createLogger(
  config: LoggingSettings,
  destination: DestinationStream = createLogDestination(config.format),
): Logger {
  return pino({
    level: config.level,
    base: { service: config.service },
    errorKey: "error",
    serializers: { error: pino.stdSerializers.err },
    redact: { paths: createSensitiveFieldPaths(), censor: "[REDACTED]" },
  }, destination);
}
