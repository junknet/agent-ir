/**
 * Windsurf 自带 web_search 工具的专属执行器。
 *
 * `GetChatMessage` 只把 `web_search` 当普通 function tool 发给模型；真实客户端在模型
 * 返回该调用后，另行调用本文件对应的 `GetWebSearchResults`，再把结果作为普通
 * `IRToolResult` 回灌下一轮。这不是通用工具协议，也不是 IROutbox 的职责：只有选择
 * Windsurf Outbox 的宿主工具循环才应显式调用它。
 *
 * 报文证据：devin_20260805T015028Z-3782106.mitm 中有两条
 * `POST /exa.api_server_pb.ApiServerService/GetWebSearchResults`：
 * application/proto、limit=8，响应各含 8 条 KnowledgeBaseItem；实际使用的字段为
 * document_id/url/title/summary。`webfetch` 只有工具定义，没有执行报文，故不在此实现。
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CHISEL_PROFILE, type ValueSource, type WindsurfClientProfile } from "./index.ts";
import { getSharedWindsurfSchema, type WindsurfSchema } from "./schema.ts";
import type { IRToolResult } from "../../ir/types.ts";

const DEFAULT_SERVER = "https://server.codeium.com";
const WEB_SEARCH_RPC_PATH = "/exa.api_server_pb.ApiServerService/GetWebSearchResults";
const DEFAULT_RESULT_LIMIT = 8;

export interface WindsurfWebSearchQuery {
  readonly query: string;
  /** 实测客户端固定发送 8；服务端是否接受其他值尚未验证。 */
  readonly limit?: number;
  readonly domain?: string;
  readonly mode?: string;
}

export interface WindsurfWebSearchDocument {
  readonly documentId: string;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
}

export interface WindsurfWebSearchClientOptions {
  /** `devin-session-token$<JWT>`；同时用于 Basic 认证和 protobuf metadata.api_key。 */
  readonly apiKey: ValueSource<string>;
  readonly server?: string;
  readonly profile?: WindsurfClientProfile;
  readonly userAgent?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly fdsPath?: string;
}

export interface WindsurfWebSearchWireRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * 与 `IRWireBody` 同一约束：后端必须是 `ArrayBuffer`。
   *
   * 裸 `Uint8Array` 在 TS 5.7 之后默认是 `Uint8Array<ArrayBufferLike>`，而 DOM lib 的
   * `BodyInit` 只收 `ArrayBuffer` 后端的视图 —— 宿主仓库若开了 `lib: ["DOM"]`，
   * 裸类型会在 `fetch` 调用处编译失败。写死后端即可，产物本来就是 ArrayBuffer 背的。
   */
  readonly body: Uint8Array<ArrayBuffer>;
}

function resolveValueSource<T>(source: ValueSource<T>): T | Promise<T> {
  return typeof source === "function"
    ? (source as () => T | Promise<T>)()
    : source;
}

function loadSchema(options: WindsurfWebSearchClientOptions): WindsurfSchema {
  return getSharedWindsurfSchema(options.fdsPath);
}

/** 编译一条实测的裸 protobuf 搜索请求；它不是 Connect 信封。 */
export async function createWindsurfWebSearchWireRequest(
  query: WindsurfWebSearchQuery,
  options: WindsurfWebSearchClientOptions,
): Promise<WindsurfWebSearchWireRequest> {
  if (query.query.length === 0) throw new Error("Windsurf web search query must not be empty");
  if (!Number.isInteger(query.limit ?? DEFAULT_RESULT_LIMIT) || (query.limit ?? DEFAULT_RESULT_LIMIT) <= 0) {
    throw new Error("Windsurf web search limit must be a positive integer");
  }

  const apiKey = await resolveValueSource(options.apiKey);
  const profile = options.profile ?? CHISEL_PROFILE;
  const schema = loadSchema(options);
  const requestDescriptor = schema.message("exa.api_server_pb.GetWebSearchResultsRequest");
  const metadataDescriptor = schema.childOf(requestDescriptor, "metadata");
  const body = toBinary(requestDescriptor, create(requestDescriptor, {
    metadata: create(metadataDescriptor, {
      apiKey,
      ideName: profile.ideName,
      extensionName: profile.extensionName,
      extensionVersion: profile.extensionVersion,
      ideVersion: profile.ideVersion,
      locale: profile.locale,
      os: profile.os,
      ...(profile.deviceFingerprint === undefined ? {} : { deviceFingerprint: profile.deviceFingerprint }),
    }),
    query: query.query,
    limit: query.limit ?? DEFAULT_RESULT_LIMIT,
    ...(query.domain === undefined ? {} : { domain: query.domain }),
    ...(query.mode === undefined ? {} : { mode: query.mode }),
  }));

  return {
    url: `${options.server ?? DEFAULT_SERVER}${WEB_SEARCH_RPC_PATH}`,
    headers: {
      "content-type": "application/proto",
      authorization: `Basic ${apiKey}`,
      "user-agent": options.userAgent ?? "connect-go/1.18.1 (go1.26.4)",
      ...(options.extraHeaders ?? {}),
    },
    body,
  };
}

/** 仅提升抓包实际返回的四个字段；不把未实证的 chunks/image/dom_tree 偷渡进通用 IR。 */
export function readWindsurfWebSearchDocuments(
  body: Uint8Array,
  options: Pick<WindsurfWebSearchClientOptions, "fdsPath"> = {},
): readonly WindsurfWebSearchDocument[] {
  const responseDescriptor = getSharedWindsurfSchema(options.fdsPath)
    .message("exa.api_server_pb.GetWebSearchResultsResponse");
  const response = fromBinary(responseDescriptor, body) as unknown as { results: readonly Record<string, unknown>[] };
  return response.results.map((item) => ({
    documentId: String(item.documentId ?? ""),
    url: String(item.url ?? ""),
    title: String(item.title ?? ""),
    summary: String(item.summary ?? ""),
  }));
}

/**
 * 把专属 RPC 的结果放回通用工具结果槽。调用 id 由先前模型输出决定，绝不能由搜索顺序推断。
 */
export function createWindsurfWebSearchToolResult(
  callId: string,
  documents: readonly WindsurfWebSearchDocument[],
): IRToolResult {
  return {
    callId,
    status: "ok",
    parts: [{ kind: "text", text: JSON.stringify({ results: documents }) }],
  };
}

/**
 * 供 Windsurf 专属宿主工具循环使用的实际请求函数。
 * 网关的通用请求转发不自动调用它：通用网关不拥有工具执行权。
 */
export async function executeWindsurfWebSearch(
  query: WindsurfWebSearchQuery,
  options: WindsurfWebSearchClientOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<readonly WindsurfWebSearchDocument[]> {
  const wire = await createWindsurfWebSearchWireRequest(query, options);
  const response = await fetchImplementation(wire.url, {
    method: "POST", headers: wire.headers, body: wire.body,
  });
  if (!response.ok) throw new Error(`Windsurf web search returned HTTP ${response.status}`);
  return readWindsurfWebSearchDocuments(new Uint8Array(await response.arrayBuffer()), options);
}
