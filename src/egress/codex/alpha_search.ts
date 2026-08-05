/** ChatGPT Codex `/codex/alpha/search` 的专属辅助调用，不是标准 Responses builtin wire。 */
import type { IRToolResult } from "../../ir/types.ts";

const CODEX_ALPHA_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";

export interface CodexAlphaSearchQuery {
  readonly query: string;
  /** 抓包仅观察到 medium；其他档位尚未验证。 */
  readonly responseLength?: "medium";
}

export interface CodexAlphaSearchWireInput {
  readonly id: string;
  readonly model: string;
  /** 已按 Responses item 形状编译的会话历史；专属工具循环拥有这份历史。 */
  readonly input: readonly unknown[];
  readonly maxOutputTokens: number;
  readonly query: CodexAlphaSearchQuery;
}

export interface CodexAlphaSearchClientOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly endpoint?: string;
}

export interface CodexAlphaSearchWireRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CodexAlphaSearchResult {
  readonly refId: string;
  readonly domain: string;
  readonly snippet: string;
  readonly title: string;
  readonly url: string;
}

/** 专属辅助调用只需要 string URL + RequestInit，不把运行时 fetch 的额外静态方法纳入契约。 */
export type CodexAlphaSearchFetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 编译抓包实际形状：commands.search_query + 固定 direct caller，而非 Responses `tools`。 */
export function createCodexAlphaSearchWireRequest(
  input: CodexAlphaSearchWireInput,
  options: CodexAlphaSearchClientOptions,
): CodexAlphaSearchWireRequest {
  if (input.query.query.length === 0) throw new Error("Codex alpha search query must not be empty");
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new Error("Codex alpha search maxOutputTokens must be a positive integer");
  }
  return {
    url: options.endpoint ?? CODEX_ALPHA_SEARCH_URL,
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      id: input.id,
      model: input.model,
      input: input.input,
      commands: { search_query: [{ q: input.query.query }], response_length: input.query.responseLength ?? "medium" },
      settings: { allowed_callers: ["direct"], external_web_access: false },
      max_output_tokens: input.maxOutputTokens,
    }),
  };
}

/** 只提升抓包实际返回的结果字段；encrypted_output/output 不是普通工具结果，不能冒充正文。 */
export function readCodexAlphaSearchResults(body: unknown): readonly CodexAlphaSearchResult[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const results = (body as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.filter((result): result is Record<string, unknown> => typeof result === "object" && result !== null && !Array.isArray(result))
    .map((result) => ({
      refId: asString(result.ref_id), domain: asString(result.domain), snippet: asString(result.snippet),
      title: asString(result.title), url: asString(result.url),
    }));
}

/** 专属搜索结果通过已有的通用工具结果槽回灌；callId 由模型调用决定，绝不依赖结果顺序。 */
export function createCodexAlphaSearchToolResult(
  callId: string,
  results: readonly CodexAlphaSearchResult[],
): IRToolResult {
  return { callId, status: "ok", parts: [{ kind: "text", text: JSON.stringify({ results }) }] };
}

export async function executeCodexAlphaSearch(
  input: CodexAlphaSearchWireInput,
  options: CodexAlphaSearchClientOptions,
  fetchImplementation: CodexAlphaSearchFetchImplementation = fetch,
): Promise<readonly CodexAlphaSearchResult[]> {
  const wire = createCodexAlphaSearchWireRequest(input, options);
  const response = await fetchImplementation(wire.url, { method: "POST", headers: wire.headers, body: wire.body });
  if (!response.ok) throw new Error(`Codex alpha search returned HTTP ${response.status}`);
  return readCodexAlphaSearchResults(await response.json());
}
