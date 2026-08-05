/**
 * Outbox 响应回写到客户端 Inbox 的单一流式链路。
 *
 * 所有调用方都遵循同一顺序：先由 Outbox readOutboxResponse 读成 IREvent，再由流守卫维护提交点与
 * 心跳，最后按客户端协议编码。这样应用装配层无需复制任何 SSE 状态机或重试判定。
 */
import { superviseUpstreamStream, type IRStreamPolicy } from "./stream_guard.ts";
import type { OutboxResponseReadInterceptionOptions, ValueOrPromise } from "./ir_message_interception_extensions.ts";
import type { EncodeOptions } from "../inbox/shared.ts";
import { INBOX_CODECS } from "../protocols.ts";
import type { IROutbox, IREvent, IRProtocol, IRRequest } from "./types.ts";

/**
 * 流守卫产物的旁路观察。观察失败不得改变已经建立的客户端流，因此调用方的异常会被隔离。
 * 这是所有 Outbox 共用的同一 IR 事件语义，不携带任何一家 wire 的私有字段。
 */
export type GuardedIREventObserver = (event: IREvent) => ValueOrPromise;

export interface OutboxResponseToInboxOptions {
  readonly protocol: IRProtocol;
  readonly clientRequest: IRRequest;
  readonly outbox: IROutbox;
  readonly outboxResponse: Response;
  readonly streamPolicy?: IRStreamPolicy;
  readonly encodeOptions: EncodeOptions;
  readonly readOptions?: OutboxResponseReadInterceptionOptions;
  /** readOutboxResponse → 流守卫之后、Inbox 编码之前的 IR 事件观察点。 */
  readonly observeGuardedIREvent?: GuardedIREventObserver;
  /** 未建模的上游帧不会编码给客户端，但调用方可以据此记录协议漂移。 */
  readonly onUnhandled?: (rawType: string, raw: unknown) => void;
}

export interface IREventsToInboxOptions {
  readonly protocol: IRProtocol;
  readonly clientRequest: IRRequest;
  readonly events: AsyncIterable<IREvent>;
  readonly streamPolicy?: IRStreamPolicy;
  readonly encodeOptions: EncodeOptions;
  readonly observeGuardedIREvent?: GuardedIREventObserver;
  readonly onUnhandled?: (rawType: string, raw: unknown) => void;
}

/** 将已读出的 IR 事件经流守卫写回对应客户端协议。 */
export function writeInboxResponseFromEvents(options: IREventsToInboxOptions): Response | Promise<Response> {
  const guarded = superviseUpstreamStream(options.events, options.streamPolicy);

  async function* observableEvents(): AsyncGenerator<IREvent> {
    for await (const event of guarded) {
      // AOP 旁路不能反过来让观测故障截断真实流。
      await Promise.resolve(options.observeGuardedIREvent?.(event)).catch(() => undefined);
      if (event.kind === "unhandled") {
        options.onUnhandled?.(event.rawType, event.raw);
        continue;
      }
      yield event;
    }
  }

  return INBOX_CODECS[options.protocol].writeClientResponse(
    observableEvents(),
    options.clientRequest,
    options.encodeOptions,
  );
}

/** 将一份已收到的 Outbox HTTP 响应立即回写为对应客户端协议的响应。 */
export function writeInboxResponseFromOutbox(options: OutboxResponseToInboxOptions): Response | Promise<Response> {
  return writeInboxResponseFromEvents({
    protocol: options.protocol,
    clientRequest: options.clientRequest,
    events: options.outbox.readOutboxResponse(options.outboxResponse, options.readOptions),
    encodeOptions: options.encodeOptions,
    ...(options.streamPolicy === undefined ? {} : { streamPolicy: options.streamPolicy }),
    ...(options.observeGuardedIREvent === undefined
      ? {}
      : { observeGuardedIREvent: options.observeGuardedIREvent }),
    ...(options.onUnhandled === undefined ? {} : { onUnhandled: options.onUnhandled }),
  });
}
