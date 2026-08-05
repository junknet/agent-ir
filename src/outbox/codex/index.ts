/**
 * ChatGPT Codex 私有 Responses WebSocket 的专属适配。
 *
 * 它不是标准 `/v1/responses` Outbox：传输是 WebSocket `response.create` 帧，续轮必须带
 * `previous_response_id`，工具定义放在 `input` 的 `additional_tools` item 里。因此它不伪装成
 * `IROutbox`（该公共契约只描述可由 fetch 发送的 POST wire），也不向 Core 增加一项只服务
 * Codex 的运输抽象。
 *
 * 已核实的 wire 来自 codex_20260805T021301Z-3991747.mitm：首帧含 input_image 和
 * additional_tools；后续三帧各回送一个 custom_tool_call_output，并以 previous_response_id
 * 续接。服务端事件 payload 与 Responses SSE 同构，只是每个 JSON payload 是一条 WebSocket
 * 文本消息；本模块将它无损喂给既有 Responses event lifter，避免复制 IR 语义。
 */
import { createOpenAIResponsesOutbox } from "../openai_responses.ts";
import type { OutboxResponseReadInterceptionOptions } from "../../ir/ir_message_interception_extensions.ts";
import type {
  IRBuildProblem, IREvent, IRLoss, IROutboxProfile, IRRequest,
} from "../../ir/types.ts";

const CODEX_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses";
const STANDARD_RESPONSES_COMPILER_URL = "https://api.openai.com/v1";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface CodexWebSocketResponseClientMetadata {
  readonly installationId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnMetadata: string;
  readonly windowId: string;
  readonly responsesLite: string;
  readonly streamRequestStartedAtMilliseconds: string;
}

export interface CodexWebSocketResponseOutboxOptions {
  /** Codex 已授权 WebSocket 的模型 id；模型路由仍由宿主决定。 */
  readonly model: string;
  /** 此端点的访问头（例如账户和 originator）由已登录宿主提取后显式注入。 */
  readonly webSocketHeaders: Readonly<Record<string, string>>;
  readonly clientMetadata: CodexWebSocketResponseClientMetadata;
  readonly webSocketUrl?: string;
}

export interface CodexWebSocketResponseCreateFrame {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
}

export type CodexWebSocketResponseCreateBuildResult =
  | { readonly ok: true; readonly frame: CodexWebSocketResponseCreateFrame; readonly losses: readonly IRLoss[] }
  | { readonly ok: false; readonly problems: readonly IRBuildProblem[]; readonly losses: readonly IRLoss[] };

type JsonRecord = Record<string, unknown>;
type CodexWebSocketMessage = string | Uint8Array;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCodexWebSocketResponseId(frame: CodexWebSocketMessage): string | null {
  let payload: unknown;
  try { payload = JSON.parse(typeof frame === "string" ? frame : TEXT_DECODER.decode(frame)); } catch { return null; }
  if (!isJsonRecord(payload) || payload.type !== "response.created" || !isJsonRecord(payload.response)) return null;
  return typeof payload.response.id === "string" && payload.response.id.length > 0 ? payload.response.id : null;
}

function createCodexWebSocketClientMetadata(metadata: CodexWebSocketResponseClientMetadata): JsonRecord {
  return {
    "x-codex-installation-id": metadata.installationId,
    turn_id: metadata.turnId,
    session_id: metadata.sessionId,
    thread_id: metadata.threadId,
    "x-codex-turn-metadata": metadata.turnMetadata,
    "x-codex-window-id": metadata.windowId,
    ws_request_header_x_openai_internal_codex_responses_lite: metadata.responsesLite,
    "x-codex-ws-stream-request-start-ms": metadata.streamRequestStartedAtMilliseconds,
  };
}

function isCodexToolOutputItem(item: unknown): item is JsonRecord {
  return isJsonRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output");
}

/**
 * 私有续轮借 `previous_response_id` 引用已有 assistant 输出，不能再重送整段历史或旧工具调用。
 * 抓包的三条续轮分别是 custom output、用户 message、custom output；因此只取最后一个 user
 * 回合的工具结果，以及该回合的普通 message。工具结果在 wire 上先于同回合尾随正文，正是
 * `lowerConversation` 的确定顺序。
 */
function selectCodexWebSocketContinuationInput(request: IRRequest, input: readonly unknown[]): readonly unknown[] {
  const lastTurn = request.conversation.turns.at(-1);
  if (lastTurn?.role !== "user") return [];

  const toolResultCount = lastTurn.parts.filter((part) => part.kind === "toolResult").length;
  const continuationToolOutputs = input.filter(isCodexToolOutputItem).slice(-toolResultCount);
  const hasOrdinaryPart = lastTurn.parts.some((part) => part.kind !== "toolResult");
  if (!hasOrdinaryPart) return continuationToolOutputs;

  const lastMessage = [...input].reverse().find((item) => isJsonRecord(item) && item.type === "message");
  return lastMessage === undefined ? continuationToolOutputs : [...continuationToolOutputs, lastMessage];
}

/**
 * 创建一个带私有会话续接状态的 Codex 适配器。
 *
 * 对同一个 `intent.identity.sessionId`，先消费本轮响应流，随后构造的下一帧会自动携带该轮
 * response id。无 sessionId 时不猜测跨请求关联关系，因此绝不发送 previous_response_id。
 */
export function createCodexWebSocketResponseOutbox(options: CodexWebSocketResponseOutboxOptions) {
  const responsesOutbox = createOpenAIResponsesOutbox({
    baseUrl: STANDARD_RESPONSES_COMPILER_URL,
    apiKey: "not-sent-to-codex-websocket",
    model: options.model,
  });
  const responseIdsBySessionId = new Map<string, string>();

  async function writeCodexWebSocketResponseCreate(
    request: IRRequest,
  ): Promise<CodexWebSocketResponseCreateBuildResult> {
    const compiled = await responsesOutbox.writeOutboxRequest(request);
    if (!compiled.ok) return compiled;

    const standardPayload = JSON.parse(compiled.wire.body) as JsonRecord;
    const input = Array.isArray(standardPayload.input) ? standardPayload.input : [];
    const tools = Array.isArray(standardPayload.tools) ? standardPayload.tools : [];
    const sessionId = request.intent.identity.sessionId;
    const previousResponseId = sessionId === undefined ? undefined : responseIdsBySessionId.get(sessionId);
    const { tools: _tools, ...responseCreateFields } = standardPayload;

    const payload: JsonRecord = {
      type: "response.create",
      ...responseCreateFields,
      client_metadata: createCodexWebSocketClientMetadata(options.clientMetadata),
      input: previousResponseId === undefined && tools.length > 0
        ? [{ type: "additional_tools", role: "assistant", tools }, ...input]
        : previousResponseId === undefined ? input : selectCodexWebSocketContinuationInput(request, input),
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
    };

    return {
      ok: true,
      frame: {
        url: options.webSocketUrl ?? CODEX_WEBSOCKET_URL,
        headers: options.webSocketHeaders,
        payload: JSON.stringify(payload),
      },
      losses: compiled.losses,
    };
  }

  async function* readCodexWebSocketResponseEvents(
    sessionId: string | undefined,
    frames: AsyncIterable<CodexWebSocketMessage>,
    readOptions?: OutboxResponseReadInterceptionOptions,
  ): AsyncGenerator<IREvent> {
    const body = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        try {
          for await (const frame of frames) {
            const responseId = readCodexWebSocketResponseId(frame);
            if (sessionId !== undefined && responseId !== null) responseIdsBySessionId.set(sessionId, responseId);
            const text = typeof frame === "string" ? frame : TEXT_DECODER.decode(frame);
            controller.enqueue(TEXT_ENCODER.encode(`data: ${text}\n\n`));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    yield* responsesOutbox.readOutboxResponse(response, readOptions);
  }

  return {
    /** 与标准 Responses 相同的语义能力表；差异只在 Codex 专属 wire/会话层。 */
    profile: responsesOutbox.profile as IROutboxProfile,
    writeCodexWebSocketResponseCreate,
    readCodexWebSocketResponseEvents,
  };
}

export {
  createCodexAlphaSearchToolResult,
  createCodexAlphaSearchWireRequest,
  executeCodexAlphaSearch,
  readCodexAlphaSearchResults,
} from "./alpha_search.ts";
