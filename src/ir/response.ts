/**
 * 响应的**文档形态**，以及从事件流折叠出它的唯一实现。
 *
 * 为什么需要它：请求侧天然是文档（发之前整段对话就在手上），响应侧天然是流（增量到达），
 * 这个不对称是domain 固有的。但「响应组装完之后长什么样」同样是 IR 该定义的东西 ——
 * 缺了它，每个出站协议都得自己从事件流折一遍，而且各折各的形状：实测本仓库两个 encoder
 * 一个累进 Anthropic wire 块、一个累进扁平的 text/toolCalls，**谁都没落到 IR 上**。
 *
 * 关键设计：`IRResponse.turn` 就是一个 assistant `IRTurn`，与请求历史里的回合**同一个类型**。
 * 于是闭环成立 —— 这一轮的响应可以直接 append 进下一轮请求的 conversation.turns，
 * 不必绕一圈 wire 再 decode 回来。请求与响应至此讲同一种语言。
 */
import type {
  IREvent, IRLoss, IRPart, IRResponsePart, IRStopReason, IRTurn, IROutboxError, IRUsage,
} from "./types.ts";

export interface IRUnhandledEvent {
  readonly rawType: string;
  readonly raw: unknown;
}

export interface IRResponse {
  readonly model: string;
  /**
   * 组装后的助手回合。part 类型收窄到模型产出形态，但因为 `IRTurn` 对 part 协变，
   * 它**仍然是**一个 `IRTurn` —— 可以直接 append 进下一轮请求的 conversation.turns。
   * 「比历史回合窄」与「是历史回合」两件事在类型上同时成立。
   */
  readonly turn: IRTurn<IRResponsePart>;
  /** 上游从未发出终止事件时为 null —— 调用方据此区分「说完了」与「连接断了」。 */
  readonly stopReason: IRStopReason | null;
  readonly usage: IRUsage | null;
  readonly error: IROutboxError | null;
  readonly losses: readonly IRLoss[];
  /** 未识别的上游事件。非空即上游协议漂移，不是可以忽略的噪音。 */
  readonly unhandled: readonly IRUnhandledEvent[];
}

/** 组装中的一个 part。tool 入参在流里是分片的 JSON 文本，收尾时才解析。 */
interface PendingPart {
  part: IRPart;
  toolInputBuffer: string;
}

interface FinalizedPart {
  readonly part: IRResponsePart | null;
  readonly loss: IRLoss | null;
}

function finalizePart(pending: PendingPart, index: number): FinalizedPart {
  const { part, toolInputBuffer } = pending;
  switch (part.kind) {
    case "text":
    case "thinking":
    case "redactedThinking":
      return { part, loss: null };
    case "toolCall": {
      if (toolInputBuffer.length === 0) return { part, loss: null };
      try {
        const parsed: unknown = JSON.parse(toolInputBuffer);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return {
            part: { ...part, call: { ...part.call, input: { kind: "json", value: parsed as Record<string, unknown> } } },
            loss: null,
          };
        }
        return {
          part: { ...part, call: { ...part.call, input: { kind: "text", text: toolInputBuffer } } },
          loss: {
            stage: "outbox", outbox: null, path: `$.response.parts[${index}].call.input`, kind: "degraded",
            detail: "tool input JSON parsed to a non-object; preserved raw fragments as freeform text",
          },
        };
      } catch {
        return {
          part: { ...part, call: { ...part.call, input: { kind: "text", text: toolInputBuffer } } },
          loss: {
            stage: "outbox", outbox: null, path: `$.response.parts[${index}].call.input`, kind: "degraded",
            detail: "tool input JSON could not be parsed; preserved raw fragments as freeform text",
          },
        };
      }
    }
    // image / document / toolResult / opaque 不属于模型的产出。走到这里说明某个 readOutboxResponse
    // 映射错了；在唯一的折叠点丢弃并留痕，好过让每个 encoder 各自 return null。
    case "image":
    case "document":
    case "toolResult":
    case "opaque":
      return { part: null, loss: null };
  }
}

/**
 * 事件流 → 响应文档。**唯一**的折叠实现，非流式出站与「把响应接回下一轮」共用它。
 *
 * 不抛异常：上游的失败是数据（`error`），不是控制流。调用方永远拿得到一个 IRResponse，
 * 靠 `error` / `stopReason === null` 判定结局。
 */
export class IRResponseAccumulator {
  readonly #pendingByIndex = new Map<number, PendingPart>();
  readonly #order: number[] = [];
  readonly #losses: IRLoss[] = [];
  readonly #unhandled: IRUnhandledEvent[] = [];
  #model: string;
  #usage: IRUsage | null = null;
  #stopReason: IRStopReason | null = null;
  #error: IROutboxError | null = null;

  constructor(fallbackModel: string) {
    this.#model = fallbackModel;
  }

  accept(event: IREvent): void {
    switch (event.kind) {
      case "messageStart":
        if (event.model.length > 0) this.#model = event.model;
        break;

      case "partStart":
        if (!this.#pendingByIndex.has(event.index)) this.#order.push(event.index);
        this.#pendingByIndex.set(event.index, { part: event.part, toolInputBuffer: "" });
        break;

      case "partDelta": {
        const pending = this.#pendingByIndex.get(event.index);
        if (pending === undefined) {
          // 没有 partStart 就来 delta：上游帧序坏了，记下来而不是静默丢内容。
          this.#unhandled.push({ rawType: "partDelta-without-partStart", raw: event });
          break;
        }
        const { part } = pending;
        const { delta } = event;
        if (delta.kind === "text" && part.kind === "text") {
          pending.part = { ...part, text: part.text + delta.text };
        } else if (delta.kind === "thinking" && part.kind === "thinking") {
          pending.part = { ...part, text: part.text + delta.text };
        } else if (delta.kind === "thinkingSignature" && part.kind === "thinking") {
          pending.part = { ...part, signature: delta.signature };
        } else if (delta.kind === "toolInputJson") {
          pending.toolInputBuffer += delta.json;
        } else if (delta.kind === "toolInputText") {
          pending.toolInputBuffer += delta.text;
        } else {
          this.#unhandled.push({ rawType: `partDelta:${delta.kind}-on-${part.kind}`, raw: event });
        }
        break;
      }

      case "partEnd":
        break;

      case "usage":
        this.#usage = event.usage;
        break;

      case "messageStop":
        this.#stopReason = event.reason;
        break;

      case "error":
        this.#error = event.error;
        break;

      case "loss":
        this.#losses.push(event.loss);
        break;

      case "unhandled":
        this.#unhandled.push({ rawType: event.rawType, raw: event.raw });
        break;

      // 传输层信号，不进响应文档：committed 是给调用方判「还能不能换号」的，
      // heartbeat 是给下游连接保活的，两者都不是模型产出。
      case "committed":
      case "heartbeat":
        break;
    }
  }

  finish(): IRResponse {
    const parts: IRResponsePart[] = [];
    for (const index of this.#order) {
      const pending = this.#pendingByIndex.get(index);
      if (pending === undefined) continue;
      const finalized = finalizePart(pending, index);
      if (finalized.loss !== null) this.#losses.push(finalized.loss);
      if (finalized.part === null) {
        this.#losses.push({
          stage: "outbox",
          outbox: null,
          path: `$.response.parts[${index}]`,
          kind: "dropped",
          detail: `'${pending.part.kind}' is not a model output shape and cannot appear in a response`,
        });
        continue;
      }
      parts.push(finalized.part);
    }

    return {
      model: this.#model, turn: { role: "assistant", parts }, stopReason: this.#stopReason,
      usage: this.#usage, error: this.#error, losses: this.#losses, unhandled: this.#unhandled,
    };
  }
}

export async function assembleResponse(
  events: AsyncIterable<IREvent>,
  fallbackModel: string,
): Promise<IRResponse> {
  const accumulator = new IRResponseAccumulator(fallbackModel);
  for await (const event of events) accumulator.accept(event);
  return accumulator.finish();
}

/**
 * 把宽的 `IRPart` 收窄成模型产出形态。返回 null 即「这不该出现在响应里」。
 * 收窄只此一处，映射函数因此可以是全函数，不必各自 `return null`。
 */
export function asResponsePart(part: IRPart): IRResponsePart | null {
  switch (part.kind) {
    case "text":
    case "thinking":
    case "redactedThinking":
    case "toolCall":
      return part;
    case "image":
    case "document":
    case "toolResult":
    case "opaque":
      return null;
  }
}
