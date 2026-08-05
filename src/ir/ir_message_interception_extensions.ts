/**
 * IRMessage 的 inbox 请求、outbox SSE 帧与 inbox 完整响应拦截链扩展。
 *
 * Interceptor 拿到的是同一个可变对象，不是副本；因此审计器既能观察，也能在边界处原地修改。
 * 请求的 `requires` 是派生字段，网关会在 inbox request interceptor 返回后重新计算，避免内容被
 * 修改后准入仍使用旧能力集。流式已经发出的字节不能回收：要改实时内容请用 SSE 帧链，要审计
 * 或修改最终文档/终止状态请用完整响应链。
 */
import type { IREvent, IRRequest } from "./types.ts";
import type { IRResponse } from "./response.ts";
import { IRResponseAccumulator } from "./response.ts";
import type { SseEvent } from "./sse.ts";

export type ValueOrPromise<T = void> = T | Promise<T>;

/** 深度移除 readonly，保留判别联合、数组和原始值的精确类型。 */
export type Mutable<T> =
  T extends (...args: never[]) => unknown ? T
  : T extends ReadonlyArray<infer Item> ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T;

export type MutableIRRequest = Mutable<IRRequest>;
export type MutableIRResponse = Mutable<IRResponse>;
export type MutableSseEvent = Mutable<SseEvent>;

export interface IRRequestInterceptionContext {
  readonly traceId: string;
  readonly protocol: IRRequest["protocol"];
}

export interface IRResponseInterceptionContext extends IRRequestInterceptionContext {
  readonly provider: string;
  readonly stream: boolean;
}

export type CompleteOutboxSseFrameProcessor = (frame: MutableSseEvent) => ValueOrPromise;
export type CompleteIRResponseProcessor = (response: MutableIRResponse) => ValueOrPromise;

/** 只在拦截器边界解除 readonly；运行时仍是原对象，不会复制。 */
export async function processCompleteIRResponse(
  response: IRResponse,
  processor: CompleteIRResponseProcessor | undefined,
): Promise<void> {
  if (processor !== undefined) await processor(response as MutableIRResponse);
}

/** Outbox lift 的可选读入拦截；非 SSE wire（如 ConnectRPC）不会调用它。 */
export interface OutboxResponseReadInterceptionOptions {
  readonly processCompleteSseFrame?: CompleteOutboxSseFrameProcessor;
}

/** OkHttp 同构的剩余链：每个 interceptor 对同一轮至多调用一次 `proceed`。 */
export interface RemainingIRMessageInterceptorChain<T> {
  proceed(next: T): Promise<T>;
}

export interface IRMessageInterceptor<T, Context> {
  readonly interceptorId: string;
  intercept(value: T, context: Context, chain: RemainingIRMessageInterceptorChain<T>): ValueOrPromise<T>;
}

export class IRRequestInterceptionRejected extends Error {
  override readonly name = "IRRequestInterceptionRejected";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 以注册顺序为唯一执行顺序的 OkHttp 风格洋葱执行器。 */
export async function executeIRMessageInterceptorChain<T, Context>(
  value: T,
  context: Context,
  interceptors: readonly IRMessageInterceptor<T, Context>[],
): Promise<T> {
  const ids = new Set<string>();
  for (const interceptor of interceptors) {
    if (ids.has(interceptor.interceptorId)) {
      throw new Error(`duplicate IR interceptor id: ${interceptor.interceptorId}`);
    }
    ids.add(interceptor.interceptorId);
  }

  const proceedFrom = async (index: number, current: T): Promise<T> => {
    const interceptor = interceptors[index];
    if (interceptor === undefined) return current;
    let proceeded = false;
    const chain: RemainingIRMessageInterceptorChain<T> = {
      async proceed(next: T): Promise<T> {
        if (proceeded) throw new Error(`IR interceptor called proceed twice: ${interceptor.interceptorId}`);
        proceeded = true;
        return proceedFrom(index + 1, next);
      },
    };
    return interceptor.intercept(current, context, chain);
  };
  return proceedFrom(0, value);
}

export interface IRMessageInterceptorChain<T, Context> {
  /** 注册完整洋葱 interceptor；不调用 `proceed` 即短路。 */
  addInterceptor(interceptor: IRMessageInterceptor<T, Context>): () => void;
  executeInterceptors(value: T, context: Context): Promise<void>;
}

class MutableIRMessageInterceptorChain<T, Context> implements IRMessageInterceptorChain<T, Context> {
  #interceptors: IRMessageInterceptor<T, Context>[] = [];

  addInterceptor(interceptor: IRMessageInterceptor<T, Context>): () => void {
    if (this.#interceptors.some((registered) => registered.interceptorId === interceptor.interceptorId)) {
      throw new Error(`duplicate IR interceptor id: ${interceptor.interceptorId}`);
    }
    this.#interceptors.push(interceptor);
    return () => {
      const index = this.#interceptors.indexOf(interceptor);
      if (index !== -1) this.#interceptors.splice(index, 1);
    };
  }

  async executeInterceptors(value: T, context: Context): Promise<void> {
    // 执行前取快照：本轮中注册/注销 interceptor 不改变当前洋葱的拓扑。
    await executeIRMessageInterceptorChain(value, context, [...this.#interceptors]);
  }
}

/**
 * 网关默认即可直接使用的三条 interceptor chain：
 *
 * - `inboxRequestInterceptorChain`：decode 后、模型路由/repair/egress 前；
 * - `outboxSseFrameInterceptorChain`：共享分帧器完成一帧（空行）后、各出口 lift 前；
 * - `inboxCompletedResponseInterceptorChain`：完整 IRResponse 已形成；流式场景在终止事件下发前触发。
 */
export interface IRMessageInterceptionExtensions {
  readonly inboxRequestInterceptorChain: IRMessageInterceptorChain<MutableIRRequest, IRRequestInterceptionContext>;
  readonly outboxSseFrameInterceptorChain: IRMessageInterceptorChain<MutableSseEvent, IRResponseInterceptionContext>;
  readonly inboxCompletedResponseInterceptorChain: IRMessageInterceptorChain<MutableIRResponse, IRResponseInterceptionContext>;
}

export function createIRMessageInterceptionExtensions(): IRMessageInterceptionExtensions {
  return {
    inboxRequestInterceptorChain: new MutableIRMessageInterceptorChain<MutableIRRequest, IRRequestInterceptionContext>(),
    outboxSseFrameInterceptorChain: new MutableIRMessageInterceptorChain<MutableSseEvent, IRResponseInterceptionContext>(),
    inboxCompletedResponseInterceptorChain: new MutableIRMessageInterceptorChain<MutableIRResponse, IRResponseInterceptionContext>(),
  };
}

/**
 * 流式路径的最终响应观察器。事件仍实时向下游传递；第一个终止事件及其后续尾帧会暂存，
 * 以保证完整响应处理器在协议层的 done/error 字节之前运行。完整文档只有在 outbox 结束时才存在。
 */
export async function* observeCompleteIRResponseBeforeStreamTermination(
  events: AsyncIterable<IREvent>,
  fallbackModel: string,
  processCompleteResponse: CompleteIRResponseProcessor,
): AsyncGenerator<IREvent> {
  const accumulator = new IRResponseAccumulator(fallbackModel);
  const deferred: IREvent[] = [];
  let terminalSeen = false;

  for await (const event of events) {
    accumulator.accept(event);
    if (terminalSeen || event.kind === "messageStop" || event.kind === "error") {
      terminalSeen = true;
      deferred.push(event);
    } else {
      yield event;
    }
  }

  const response = accumulator.finish();
  await processCompleteIRResponse(response, processCompleteResponse);
  for (const event of deferred) {
    // 流正文已经交给客户端，唯一还能安全映射的可见字段是终止状态/错误。
    if (event.kind === "messageStop" && response.error === null && response.stopReason !== null) {
      yield { ...event, reason: response.stopReason };
    } else if (event.kind === "error" && response.error !== null) {
      yield { ...event, error: response.error };
    } else {
      yield event;
    }
  }
}
