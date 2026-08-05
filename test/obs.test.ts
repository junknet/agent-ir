import { Writable } from "node:stream";
import { describe, expect, it } from "bun:test";
import type { DestinationStream } from "pino";
import { createLogger } from "../src/obs/log.ts";

function createCapturedDestination(lines: string[]): DestinationStream {
  return new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  }) as DestinationStream;
}

describe("Pino 日志装配", () => {
  it("使用 Pino 原生等级判定，并脱敏敏感字段", () => {
    const lines: string[] = [];
    const log = createLogger(
      { level: "info", service: "agent-ir", format: "json" },
      createCapturedDestination(lines),
    );

    expect(log.isLevelEnabled("debug")).toBe(false);
    expect(log.isLevelEnabled("info")).toBe(true);
    log.info({
      event: "outbox.request",
      authorization: "Bearer secret",
      request: { api_key: "sk-secret", "api-key": "sk-hyphenated-secret" },
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: 30,
      service: "agent-ir",
      event: "outbox.request",
      authorization: "[REDACTED]",
      request: { api_key: "[REDACTED]", "api-key": "[REDACTED]" },
    });
  });

  it("错误对象经 Pino serializer 保留消息与栈", () => {
    const lines: string[] = [];
    const log = createLogger(
      { level: "debug", service: "agent-ir", format: "json" },
      createCapturedDestination(lines),
    );
    const error = new Error("request failed");
    log.error({ event: "outbox.request.failed", error });

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "outbox.request.failed",
      error: { message: "request failed", stack: error.stack },
    });
  });
});
