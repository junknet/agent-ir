/**
 * 三个入口读入函数的桶文件 —— **只做转出，不再持有任何注册表**。
 *
 * 上一版在这里另写了一张 `CLIENT_REQUEST_READERS`（协议 → 读入函数）和一张与
 * `src/protocols.ts` 字节相同的 `INBOX_PATHS`。两处各自维护，新增或改名一个协议时
 * 漏改哪一张都不会有任何东西报错：注册表用旧函数、路由指向不存在的端点，都只在运行时冒出来。
 *
 * 现在协议 → codec 的注册表只有 `INBOX_CODECS` 一份，本文件的分发直接查它。
 */
import { INBOX_CODECS } from "../protocols.ts";
import type { ClientRequestReadResult, IRProtocol } from "../ir/types.ts";

export type { ClientRequestReader } from "../ir/codec.ts";

export function readClientRequestForProtocol(protocol: IRProtocol, raw: unknown, traceId: string): ClientRequestReadResult {
  return INBOX_CODECS[protocol].readClientRequest(raw, traceId);
}

export { readAnthropicMessagesRequest } from "./anthropic_messages.ts";
export { readChatCompletionsRequest } from "./openai_chat_completions.ts";
export { readResponsesRequest } from "./openai_responses.ts";
