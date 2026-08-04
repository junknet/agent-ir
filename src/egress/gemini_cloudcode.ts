/**
 * Gemini via Google CloudCode 出口（`v1internal:streamGenerateContent`）。
 *
 * 这是第一个**结构上不像 Anthropic** 的出口，值得单独说清它逼出来的三件事：
 *
 * 1. **流里没有生命周期事件。** Anthropic 有 `content_block_start/stop` 明确划块，
 *    Gemini 只有 `candidates[0].content.parts[]` 直接出现。所以 `partStart` / `partEnd`
 *    在这里是**合成**的：按「part 种类发生切换」切边界（见 `PartCursor`）。合成边界不会
 *    凭空造内容，但它确实是本出口的解释，不是上游的原话 —— 下游 encoder 产出的帧序因此
 *    与「假如 Gemini 自己有 block 事件」不一定逐帧相同，只保证**内容与顺序**一致。
 *
 * 2. **终止靠 `finishReason`，没有终止帧。** 一个 `finishReason` 都没等到 = 流被掐断，
 *    必须 yield `error` 而不是安静收尾（实测踩过：客户端分不清截断与真结束，只能盲重试）。
 *
 * 3. **`thoughtSignature` 在 IR 里没有落点。** 它是挂在 `functionCall`/`text` part 上的
 *    兄弟字段，语义是「这次工具调用背后的推理凭据」，与 Anthropic 挂在 thinking 块上的
 *    `signature` **不是同一个东西**（见文件末尾 `THOUGHT_SIGNATURE_CACHE` 的长注释）。
 *    IR 的 `IRResponsePart` 只收 text/thinking/redactedThinking/toolCall，opaque 装不进
 *    响应，于是它只能走进程内的旁路缓存 —— 每条流首次遇到都记一条 `loss`，让这个缺口
 *    可见而不是隐形。
 *
 * wire 知识全部来自实测：`agent-all-sdk-ts/src/providers/antigravity_provider.ts`
 * （639 行踩坑记录）+ `PROTOCOL_REFERENCE.md` §1.1/§4.1/§5.1/§6/§7/§8
 * + 网关流量日志 2026-08-02..04 的 8463 条 `upstream_sse`（part 形态五种、
 * finishReason 仅 STOP 1522 / MAX_TOKENS 80、text part 实测 88/88 为**增量**不是累积）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryParseJson } from "../ir/sse.ts";
import type {
  IREgress, IREgressProfile, IREvent, IRJsonSchema, IRLoss, UpstreamRequestBuildResult, IRPart,
  IRReasoning, IRRequest, IRStopReason, IRToolResult, IRUpstreamError, IRUsage,
} from "../ir/types.ts";

const PROVIDER = "gemini_cloudcode";

/**
 * 能进 supports 的只有**有实测证据**的。存疑的一律不放 —— 放错了准入就会把请求送进
 * 一个语义模糊的 4xx，而 L2 的全部价值就是先裁决再发。
 */
const SUPPORTED = [
  // 上游只有流式端点；非流式由入口侧折叠（lower 会为此记一条 substituted）。
  "stream", "nonStream",
  "systemPrompt", "multiTurn",
  // parts[].inlineData，31 种 MIME（PROTOCOL_REFERENCE §8）含 image/* 与 application/pdf。
  "image", "document",
  // includeThoughts=true → `{thought:true,text}` part，实测 555 次。
  "thinking",
  // thinkingConfig.thinkingBudget 是原生表示，不需要换算。
  "reasoningBudget",
  "toolFunction",
  // 并行调用无开关：Gemini 一个 candidate 里可以出多个 functionCall，本来就允许。
  "toolParallel",
  // functionCallingConfig.mode=ANY + allowedFunctionNames=[name]。
  "toolChoiceSpecific",
  "maxOutputTokens", "stopSequences", "temperature", "topP",
] as const;

/**
 * 能承载但有损。每一条都在 lower 里另有一条**带具体路径**的 loss，
 * 准入那条只是「这家整体上对这个能力有损」的兜底。
 */
const LOSSY = [
  // Anthropic 的 thinking.signature 是**思考块**的完整性凭据；Gemini 的 thoughtSignature
  // 挂在 functionCall/text 上。两者不同构，回放时没有对应字段，只能丢。
  "thinkingSignature",
  // Gemini 侧「推理档位」是 token 预算（且实测由 model id 决定），effort 只能换算。
  "reasoningEffort",
  // 没有自由文本入参工具，包成单字段 schema。
  "toolFreeform",
  // 没有 namespace，分组拍进名字。
  "toolGroup",
  // functionResponse.response 是 JSON struct，图片只能 base64 塞字段里，
  // 模型能不能真的当图片看是未知的。
  "toolResultImage",
  // 没有 is_error 这类协议级标志，只能约定 `{error: ...}`。
  "toolResultError",
  // PROTOCOL_REFERENCE §7：cloudcode 私有面不暴露 cachedContent，断点无处安放。
  "cacheBreakpoint",
  // 没有服务端上下文管理指令，只能丢（丢了只是历史更长，不影响正确性）。
  "contextEdit",
  // 标准 Gemini generationConfig 有 topK，但 v1internal 未实测，宁可丢不冒 400。
  "topK",
  // 没有服务档位概念。
  "serviceTier",
] as const;

// 完全不支持（既不在 supports 也不在 lossy，准入直接判该出口不可用）：
//   toolBuiltin      —— IR 的 builtin 身份（computer_*/web_search…）在 cloudcode 私有面
//                       没有对应物；googleSearch/codeExecution 是另一套名字，硬映射等于猜。
//   structuredOutput —— 标准 Gemini 有 responseMimeType+responseSchema，v1internal 未实测。
//                       「不确定就不要放进 supports」，宁可让准入 422 到精确路径。

// ── 凭据 ────────────────────────────────────────────────────────────────────

/** 同步或异步都行：调用方可以给常量、给一个刷新函数、或给一个共享的 token 池。 */
export type ValueSource<T> = T | (() => T | Promise<T>);

async function resolveSource<T>(source: ValueSource<T>): Promise<T> {
  return typeof source === "function" ? await (source as () => T | Promise<T>)() : source;
}

export interface GeminiCloudCodeEgressOptions {
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  readonly accessToken: ValueSource<string>;
  /** cloudaicompanion project。解析方式见 `createCloudCodeProjectSource`。 */
  readonly project: ValueSource<string>;
  readonly host?: string;
  readonly userAgent?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * 模型档位自带的思考预算（`fetchAvailableModels` 的 thinkingBudget）。
   * 给了就**压过**客户端的 budget/effort —— Gemini 的档位是模型 id 的属性，不是运行时参数。
   * `-1` = 动态，wire 上表现为省略 thinkingBudget。
   */
  readonly thinkingBudget?: number;
  /** 上游 maxOutputTokens 上限，默认 65536（实测全系 Gemini 同值）。 */
  readonly maxOutputTokensCap?: number;
  /** `labels.model_enum`，如 `MODEL_PLACEHOLDER_M71`。 */
  readonly modelEnum?: string;
  readonly sessionId?: ValueSource<string>;
  readonly requestIdFactory?: () => string;
}

export interface GeminiOAuthCredentials {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expiry_date?: number;
  readonly token_type?: string;
  readonly scope?: string;
  readonly id_token?: string;
}

const DEFAULT_HOST = "cloudcode-pa.googleapis.com";
const DEFAULT_USER_AGENT = "antigravity/fantasy/1.0.0 linux/amd64";
/** PROTOCOL_REFERENCE §1.1：Antigravity 的公开 OAuth 客户端。 */
const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ?? process.env.GEMINI_OAUTH_CLIENT_SECRET ?? "";

export function defaultGeminiCredentialsPath(): string {
  return join(homedir(), ".gemini", "oauth_creds.json");
}

export function readGeminiOAuthCredentials(path = defaultGeminiCredentialsPath()): GeminiOAuthCredentials {
  const parsed = tryParseJson<GeminiOAuthCredentials>(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed.access_token !== "string") {
    throw new Error(`invalid Gemini OAuth credentials at ${path}`);
  }
  return parsed;
}

/**
 * `~/.gemini/oauth_creds.json` 的 access token 源，过期前 60s 才走刷新。
 *
 * 实测坑（PROTOCOL_REFERENCE §1.1）：本机到 `oauth2.googleapis.com/token` 的链路不稳，
 * 而 `cloudcode-pa` 通畅 —— 所以**优先复用未过期的 access_token**，不是每次都刷。
 */
export function createGeminiOAuthTokenSource(
  options: { readonly path?: string; readonly fetchImpl?: typeof fetch } = {},
): () => Promise<string> {
  const path = options.path ?? defaultGeminiCredentialsPath();
  const doFetch = options.fetchImpl ?? fetch;
  return async () => {
    const store = readGeminiOAuthCredentials(path);
    const fresh = store.expiry_date !== undefined && Date.now() + 60_000 < store.expiry_date;
    if (fresh && store.access_token.length > 0) return store.access_token;
    if (store.refresh_token === undefined) {
      throw new Error("Gemini access token expired and no refresh_token is available");
    }
    const response = await doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        refresh_token: store.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Gemini token refresh failed: ${response.status} ${await response.text()}`);
    }
    const data = tryParseJson<Record<string, unknown>>(await response.text());
    const token = typeof data?.access_token === "string" ? data.access_token : null;
    if (token === null) throw new Error("Gemini token refresh returned no access_token");
    const next: Record<string, unknown> = { ...store, access_token: token };
    if (typeof data?.expires_in === "number") next.expiry_date = Date.now() + data.expires_in * 1000;
    if (typeof data?.refresh_token === "string") next.refresh_token = data.refresh_token;
    if (typeof data?.id_token === "string") next.id_token = data.id_token;
    try { writeFileSync(path, JSON.stringify(next, null, 2), "utf8"); } catch { /* 只读凭据目录也不该打死出口 */ }
    return token;
  };
}

/**
 * project 解析。
 *
 * 实测（2026-07-30）：`loadCodeAssist` 不再回 `cloudaicompanionProject` —— free-tier 被划入
 * `ineligibleTiers`(UNSUPPORTED_CLIENT / UNSUPPORTED_LOCATION)，仅剩的 standard-tier 标着
 * `userDefinedCloudaicompanionProject:true`，服务端不再自动分配。Antigravity CLI 1.1.8 在同样
 * 情况下用固定串 `default-cli-project`，且 `streamGenerateContent` 实测接受它。
 * 抛错会打死整条出口，所以降级到该默认值。
 */
export function createCloudCodeProjectSource(
  options: {
    readonly accessToken: ValueSource<string>;
    readonly host?: string;
    readonly fallbackProject?: string;
    readonly fetchImpl?: typeof fetch;
    readonly userAgent?: string;
  },
): () => Promise<string> {
  const host = options.host ?? DEFAULT_HOST;
  const doFetch = options.fetchImpl ?? fetch;
  const fallback = options.fallbackProject ?? "default-cli-project";
  const cache = new Map<string, string>();
  return async () => {
    const token = await resolveSource(options.accessToken);
    const cached = cache.get(token);
    if (cached !== undefined) return cached;
    const response = await doFetch(`https://${host}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    });
    let project = fallback;
    if (response.ok) {
      const data = tryParseJson<Record<string, unknown>>(await response.text());
      if (typeof data?.cloudaicompanionProject === "string" && data.cloudaicompanionProject.length > 0) {
        project = data.cloudaicompanionProject;
      }
    }
    // 长驻网关里 token 会轮换，缓存要有界。
    if (cache.size > 256) cache.clear();
    cache.set(token, project);
    return project;
  };
}

// ── lower ──────────────────────────────────────────────────────────────────

class UpstreamRequestLosses {
  readonly #losses: IRLoss[] = [];
  record(loss: Omit<IRLoss, "stage" | "provider">): void {
    this.#losses.push({ stage: "egress", provider: PROVIDER, ...loss });
  }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
}

function flatToolName(group: string | null, name: string): string {
  return group === null ? name : `${group}__${name}`;
}

/**
 * Gemini 只吃 OpenAPI Schema 的一个子集。多余的键**静默**丢会让工具行为漂移
 * （`additionalProperties:false`、`anyOf`、`format` 全都影响模型怎么填参数），
 * 所以这里把丢掉的键名收集起来，由调用方记 loss。
 */
const ALLOWED_SCHEMA_KEYS = new Set([
  "type", "properties", "items", "required", "description", "enum", "nullable",
]);

const GEMINI_TYPE_MAP: Readonly<Record<string, string>> = {
  string: "STRING", number: "NUMBER", integer: "INTEGER",
  boolean: "BOOLEAN", array: "ARRAY", object: "OBJECT",
};

function cleanGeminiSchema(schema: unknown, dropped: Set<string>): unknown {
  if (Array.isArray(schema)) return schema.map((item) => cleanGeminiSchema(item, dropped));
  if (schema === null || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  let type: unknown = source.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) cleaned.nullable = true;
    type = type.find((item) => item !== "null");
  }
  if (typeof type === "string") {
    cleaned.type = GEMINI_TYPE_MAP[type.toLowerCase()] ?? type.toUpperCase();
  }

  for (const key of Object.keys(source)) {
    if (key === "type") continue;
    if (!ALLOWED_SCHEMA_KEYS.has(key)) { dropped.add(key); continue; }
    if (key === "properties") {
      const props = source[key];
      const out: Record<string, unknown> = {};
      if (props !== null && typeof props === "object" && !Array.isArray(props)) {
        for (const name of Object.keys(props)) {
          out[name] = cleanGeminiSchema((props as Record<string, unknown>)[name], dropped);
        }
      }
      cleaned[key] = out;
    } else if (key === "items") {
      cleaned[key] = cleanGeminiSchema(source[key], dropped);
    } else {
      cleaned[key] = source[key];
    }
  }
  return cleaned;
}

type GeminiPart = Record<string, unknown>;

interface LowerContext {
  readonly toolNameByCallId: ReadonlyMap<string, string>;
  readonly losses: UpstreamRequestLosses;
}

/** 一条 IRPart → 0..n 个 Gemini part。返回数组而不是 `T | null`：一个 part 可能落成零个。 */
function writePartToUpstream(part: IRPart, path: string, ctx: LowerContext): GeminiPart[] {
  const { losses } = ctx;
  if (part.cacheBreakpoint !== undefined) {
    losses.record({
      path: `${path}.cacheBreakpoint`, kind: "dropped",
      detail: "cloudcode 私有面不暴露 cachedContent，prompt caching 无显式断点可设"
        + "（PROTOCOL_REFERENCE §7），该断点被忽略",
    });
  }

  switch (part.kind) {
    case "text":
      return part.text.length === 0 ? [] : [{ text: part.text }];

    case "image":
    case "document": {
      if (part.media.source.kind !== "base64") {
        losses.record({
          path, kind: "dropped",
          detail: `${part.kind} 以 url 提供；cloudcode 私有面没有 File API/fileData 通道，无法搬运`,
        });
        return [];
      }
      if (part.kind === "document" && part.title !== undefined) {
        losses.record({
          path, kind: "dropped",
          detail: "Gemini inlineData 只有 mimeType/data，文档标题没有承载字段",
        });
      }
      return [{ inlineData: { mimeType: part.media.mediaType, data: part.media.source.data } }];
    }

    case "thinking":
      // Gemini 的 contents 里没有 thought part 的回放通道 —— 上游只认挂在 functionCall/text
      // 上的 thoughtSignature（见文件末尾）。整块思考只能丢。
      losses.record({
        path, kind: "dropped",
        detail: "Gemini contents 无 thinking part 通道；历史思考文本无法回放"
          + (part.signature === undefined ? "" : "，Anthropic 的 thinking.signature 亦无对应字段"),
      });
      return [];

    case "redactedThinking":
      losses.record({
        path, kind: "dropped",
        detail: "Gemini 无 redacted_thinking 对应形态",
      });
      return [];

    case "toolCall": {
      const name = flatToolName(part.call.toolRef.group, part.call.toolRef.name);
      if (part.call.toolRef.group !== null) {
        losses.record({
          path, kind: "degraded",
          detail: `tool group '${part.call.toolRef.group}' 拍进函数名；Gemini 无 namespace 概念`,
        });
      }
      let args: Record<string, unknown>;
      if (part.call.input.kind === "json") {
        args = part.call.input.value;
      } else {
        args = { input: part.call.input.text };
        losses.record({
          path, kind: "degraded",
          detail: "freeform 工具入参包成 `{input:<text>}`；Gemini functionCall.args 只能是结构化对象",
        });
      }
      const cached = recallThoughtSignature(part.call.id);
      if (cached === undefined) {
        losses.record({
          path, kind: "substituted",
          detail: "该 tool call 没有已知的 thoughtSignature（非本出口产出或已淘汰），"
            + "回填占位符 skip_thought_signature_validator：上游会放行但这一步的推理线索断了",
        });
      }
      return [{
        functionCall: { id: part.call.id, name, args },
        thoughtSignature: cached ?? THOUGHT_SIGNATURE_PLACEHOLDER,
      }];
    }

    case "toolResult":
      return [{
        functionResponse: {
          id: part.result.callId,
          name: ctx.toolNameByCallId.get(part.result.callId) ?? fallbackToolName(part.result.callId, path, losses),
          response: lowerToolResult(part.result, path, losses),
        },
      }];

    case "opaque":
      // IRProtocol 里没有 gemini，任何 opaque 都是异源的，翻译不了。
      losses.record({
        path, kind: "dropped",
        detail: `opaque part from ${part.origin} (${part.tag}) 在 Gemini 没有对应形态`,
      });
      return [];
  }
}

function fallbackToolName(callId: string, path: string, losses: UpstreamRequestLosses): string {
  losses.record({
    path, kind: "substituted",
    detail: `tool result ${callId} 在历史里找不到对应的调用，functionResponse.name 只能填 'tool'`,
  });
  return "tool";
}

/**
 * tool 结果 → `functionResponse.response`（一个 JSON struct，不是 content 数组）。
 * 形状照抄实测可用的 antigravity_provider：错误走 `{error}`，图片 base64 塞字段。
 */
function lowerToolResult(result: IRToolResult, path: string, losses: UpstreamRequestLosses): Record<string, unknown> {
  const texts: string[] = [];
  const images: Array<{ media_type: string; data: string }> = [];
  for (const [index, inner] of result.parts.entries()) {
    if (inner.kind === "text") { if (inner.text.length > 0) texts.push(inner.text); continue; }
    if ((inner.kind === "image" || inner.kind === "document") && inner.media.source.kind === "base64") {
      images.push({ media_type: inner.media.mediaType, data: inner.media.source.data });
      continue;
    }
    losses.record({
      path: `${path}.result.parts[${index}]`, kind: "dropped",
      detail: `'${inner.kind}' 无法进入 functionResponse.response（它是 JSON struct，不是 content 数组）`,
    });
  }
  const text = texts.join("\n\n");

  if (result.status === "error") {
    losses.record({
      path, kind: "degraded",
      detail: "Gemini functionResponse 没有 is_error 这类协议级标志，错误只能约定成 `{error:<text>}`",
    });
    return { error: text };
  }
  if (images.length > 0) {
    losses.record({
      path, kind: "degraded",
      detail: `${images.length} 张图片 base64 塞进 functionResponse.response 的字段里；`
        + "Gemini 的工具结果是 JSON struct，模型是否真按图片解读未经实测",
    });
    const first = images[0] as { media_type: string; data: string };
    return { media_type: first.media_type, data: first.data, text, images };
  }
  if (result.status === "missing") {
    return { result: text.length === 0 ? "[gateway: tool result missing from client history; treat as unknown]" : text };
  }
  return { result: text };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function lowerContents(request: IRRequest, ctx: LowerContext): GeminiContent[] {
  const contents: GeminiContent[] = [];
  request.conversation.turns.forEach((turn, turnIndex) => {
    const role: "user" | "model" = turn.role === "assistant" ? "model" : "user";
    const parts = turn.parts.flatMap((part, partIndex) =>
      writePartToUpstream(part, `$.conversation.turns[${turnIndex}].parts[${partIndex}]`, ctx));
    if (parts.length === 0) return;
    const previous = contents[contents.length - 1];
    // Gemini 不接受相邻同角色的 content，合并而不是新开一条。
    if (previous !== undefined && previous.role === role) { previous.parts.push(...parts); return; }
    contents.push({ role, parts });
  });
  return contents;
}

/** effort → thinkingBudget。IR 明确不在 ingress 互转，换算发生在这里并留痕。 */
const EFFORT_BUDGET: Readonly<Record<string, number>> = {
  minimal: 128, low: 1000, medium: 4000, high: 10000, xhigh: 24000, max: 32768,
};

const DEFAULT_MAX_OUTPUT = 65536;
/**
 * 思考预算之外至少留给正文的额度。CloudCode 把 thinkingBudget 算在 maxOutputTokens 里，
 * 客户端给的 max_tokens 若不大于 budget，思考会把额度吃光 —— 上游返回 200 但正文为空，
 * 看起来像「模型坏了」（实测 max_tokens=20 + budget=10000 就是全空）。
 */
const MIN_VISIBLE_TOKENS = 4096;

function resolveThinking(
  reasoning: IRReasoning,
  options: GeminiCloudCodeEgressOptions,
  losses: UpstreamRequestLosses,
): { config: Record<string, unknown> | null; budget: number } {
  if (reasoning.mode === "disabled") {
    losses.record({
      path: "$.intent.reasoning.mode", kind: "dropped",
      detail: "Gemini 的思考档位由模型 id 决定；cloudcode 私有面没有实测过的关闭开关，"
        + "客户端的 disabled 意图被忽略（thinkingConfig 整体不发）",
    });
    return { config: null, budget: 0 };
  }

  let budget: number;
  if (options.thinkingBudget !== undefined) {
    budget = options.thinkingBudget;
    if (reasoning.budgetTokens !== undefined && reasoning.budgetTokens !== budget) {
      losses.record({
        path: "$.intent.reasoning.budgetTokens", kind: "substituted",
        detail: `客户端要 ${reasoning.budgetTokens}，出站模型档位自带 ${budget}；`
          + "Gemini 的档位是模型 id 的属性，档位预算胜出",
      });
    } else if (reasoning.effort !== undefined) {
      losses.record({
        path: "$.intent.reasoning.effort", kind: "substituted",
        detail: `effort='${reasoning.effort}' 无对应 wire 字段，改由出站模型档位的 thinkingBudget=${budget} 表达`,
      });
    }
  } else if (reasoning.budgetTokens !== undefined) {
    budget = reasoning.budgetTokens;
  } else if (reasoning.effort !== undefined) {
    budget = EFFORT_BUDGET[reasoning.effort] ?? 4000;
    losses.record({
      path: "$.intent.reasoning.effort", kind: "substituted",
      detail: `Gemini 只有 token 预算，effort='${reasoning.effort}' 换算成 thinkingBudget=${budget}`,
    });
  } else {
    budget = -1;
  }

  const config: Record<string, unknown> = { includeThoughts: reasoning.display !== "hidden" };
  // budget<=0（含 -1 动态）→ 省略 thinkingBudget，由服务端自行分配。
  if (budget > 0) config.thinkingBudget = budget;
  return { config, budget };
}

export function createGeminiCloudCodeUpstream(options: GeminiCloudCodeEgressOptions): IREgress {
  const profile: IREgressProfile = {
    provider: PROVIDER,
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
  };
  const host = options.host ?? DEFAULT_HOST;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  return {
    profile,

    async writeUpstreamRequest(request: IRRequest): Promise<UpstreamRequestBuildResult> {
      const losses = new UpstreamRequestLosses();
      const { conversation, intent } = request;

      const [accessToken, project, sessionId] = await Promise.all([
        resolveSource(options.accessToken),
        resolveSource(options.project),
        options.sessionId === undefined ? Promise.resolve(Date.now().toString()) : resolveSource(options.sessionId),
      ]);

      // 工具名按 callId 索引：functionResponse 必须带 name，而 IR 的 toolResult 只有 callId
      // （不变量 1：关联用 id）。这一步就是把 id 关联翻译成 Gemini 要的冗余字段。
      const toolNameByCallId = new Map<string, string>();
      for (const turn of conversation.turns) {
        for (const part of turn.parts) {
          if (part.kind !== "toolCall") continue;
          toolNameByCallId.set(part.call.id, flatToolName(part.call.toolRef.group, part.call.toolRef.name));
        }
      }
      const ctx: LowerContext = { toolNameByCallId, losses };

      // systemInstruction 实测形态是 `{role:'user', parts:[{text}]}`，只见过 text。
      const systemTexts: string[] = [];
      conversation.system.forEach((part, index) => {
        const path = `$.conversation.system[${index}]`;
        if (part.kind === "text") {
          if (part.cacheBreakpoint !== undefined) {
            losses.record({
              path: `${path}.cacheBreakpoint`, kind: "dropped",
              detail: "cloudcode 私有面不暴露 cachedContent，system 上的缓存断点被忽略（PROTOCOL_REFERENCE §7）",
            });
          }
          if (part.text.length > 0) systemTexts.push(part.text);
          return;
        }
        losses.record({
          path, kind: "dropped",
          detail: `systemInstruction 实测只承载 text part，'${part.kind}' 无处安放`,
        });
      });

      const contents = lowerContents(request, ctx);

      const declarations = conversation.toolset.tools.flatMap((tool, index) => {
        const path = `$.conversation.toolset.tools[${index}]`;
        const name = flatToolName(tool.ref.group, tool.ref.name);
        if (tool.ref.group !== null) {
          losses.record({
            path, kind: "degraded",
            detail: `tool group '${tool.ref.group}' 拍进函数名；Gemini 无 namespace 概念`,
          });
        }
        if (tool.kind === "builtin") {
          losses.record({
            path, kind: "dropped",
            detail: `builtin 工具 '${tool.builtin}' 在 cloudcode 私有面没有对应身份，无法转达`,
          });
          return [];
        }
        if (tool.kind === "freeform") {
          losses.record({
            path, kind: "degraded",
            detail: `freeform 工具 '${name}' 包成单字段 JSON schema；Gemini 只有结构化入参`,
          });
          return [{
            name, description: tool.description,
            parameters: { type: "OBJECT", properties: { input: { type: "STRING" } }, required: ["input"] },
          }];
        }
        if (tool.strict === true) {
          losses.record({
            path, kind: "dropped",
            detail: "Gemini functionDeclarations 无 strict 开关；严格校验意图无法转达",
          });
        }
        if (tool.deferLoading === true) {
          losses.record({
            path, kind: "dropped",
            detail: "Gemini 无工具定义延迟加载的表达",
          });
        }
        const dropped = new Set<string>();
        const schema: IRJsonSchema = tool.schema;
        const parameters = cleanGeminiSchema(
          Object.keys(schema).length === 0 ? { type: "object", properties: {} } : schema,
          dropped,
        );
        if (dropped.size > 0) {
          losses.record({
            path, kind: "degraded",
            detail: `schema 键 ${[...dropped].sort().join(", ")} 被剔除；`
              + "Gemini 只接受 type/properties/items/required/description/enum/nullable",
          });
        }
        return [{ name, description: tool.description, parameters }];
      });

      const choice = conversation.toolset.choice;
      const functionCallingConfig: Record<string, unknown> = (() => {
        if (choice.source !== "client") {
          // 实测 agy 的默认就是 VALIDATED（按 schema 校验模型填的参数）。
          return { mode: "VALIDATED" };
        }
        switch (choice.value.kind) {
          case "auto": return { mode: "AUTO" };
          case "none": return { mode: "NONE" };
          case "required": return { mode: "ANY" };
          case "specific": return {
            mode: "ANY",
            allowedFunctionNames: [flatToolName(choice.value.ref.group, choice.value.ref.name)],
          };
        }
      })();
      if (conversation.toolset.parallel.source === "client" && !conversation.toolset.parallel.value) {
        losses.record({
          path: "$.conversation.toolset.parallel", kind: "dropped",
          detail: "Gemini 没有关闭并行调用的开关；一个 candidate 里出多个 functionCall 无法禁止",
        });
      }

      const reasoning = intent.reasoning.value;
      const thinking = resolveThinking(reasoning, options, losses);

      const cap = options.maxOutputTokensCap ?? DEFAULT_MAX_OUTPUT;
      const floor = thinking.budget > 0 ? thinking.budget + MIN_VISIBLE_TOKENS : 0;
      const requestedMax = intent.stopping.maxOutputTokens?.value;
      const maxOutputTokens = Math.min(cap, Math.max(requestedMax ?? cap, floor));
      if (requestedMax !== undefined && maxOutputTokens !== requestedMax) {
        losses.record({
          path: "$.intent.stopping.maxOutputTokens", kind: "substituted",
          detail: maxOutputTokens > requestedMax
            ? `客户端要 ${requestedMax}，抬到 ${maxOutputTokens}：CloudCode 把 thinkingBudget(${thinking.budget}) `
              + "算在 maxOutputTokens 里，不留正文额度会返回 200 但正文全空"
            : `客户端要 ${requestedMax}，封到上游上限 ${maxOutputTokens}`,
        });
      }

      const generationConfig: Record<string, unknown> = { maxOutputTokens };
      if (intent.sampling.temperature !== undefined) generationConfig.temperature = intent.sampling.temperature.value;
      if (intent.sampling.topP !== undefined) generationConfig.topP = intent.sampling.topP.value;
      if (intent.sampling.topK !== undefined) {
        losses.record({
          path: "$.intent.sampling.topK", kind: "dropped",
          detail: "v1internal 是否接受 generationConfig.topK 未经实测；宁可丢也不冒整条请求 400 的风险",
        });
      }
      if (intent.stopping.stopSequences !== undefined) {
        generationConfig.stopSequences = [...intent.stopping.stopSequences.value];
      }
      if (thinking.config !== null) generationConfig.thinkingConfig = thinking.config;

      if (intent.outputFormat.value.kind === "jsonSchema") {
        // 正常路径上准入就拦下了（structuredOutput 不在 supports ∪ lossy）；
        // 绕过准入直接 lower 时也不能静默丢。
        losses.record({
          path: "$.intent.outputFormat", kind: "dropped",
          detail: "v1internal 的 responseMimeType/responseSchema 未经实测，结构化输出约束未下发",
        });
      }
      if (intent.contextEdits.length > 0) {
        losses.record({
          path: "$.intent.contextEdits", kind: "dropped",
          detail: `${intent.contextEdits.length} 条上下文编辑指令被丢弃；Gemini 无服务端上下文管理通道`,
        });
      }
      if (intent.serviceTier.source === "client" && intent.serviceTier.value === "priority") {
        losses.record({
          path: "$.intent.serviceTier", kind: "dropped",
          detail: "cloudcode 私有面没有服务档位概念",
        });
      }
      if (!intent.stream.value) {
        losses.record({
          path: "$.intent.stream", kind: "substituted",
          detail: "上游只有 streamGenerateContent；非流式请求改为流式取回后由入口侧折叠成整段响应",
        });
      }

      const requestId = options.requestIdFactory?.()
        ?? `agent/${sessionId}/${Date.now()}/${Math.random().toString(16).slice(2, 10)}/2`;
      const labels: Record<string, unknown> = {
        used_claude: "false",
        used_claude_conservative: "false",
        trajectory_id: trajectoryFromRequestId(requestId),
        last_step_index: "0",
      };
      if (options.modelEnum !== undefined) labels.model_enum = options.modelEnum;

      const inner: Record<string, unknown> = {
        contents,
        sessionId,
        ...(systemTexts.length === 0 ? {} : { systemInstruction: { role: "user", parts: [{ text: systemTexts.join("\n\n") }] } }),
        ...(declarations.length === 0 ? {} : {
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig },
        }),
        generationConfig,
        labels,
      };

      return {
        wire: {
          url: `https://${host}/v1internal:streamGenerateContent?alt=sse`,
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            "cache-control": "no-cache",
            "user-agent": userAgent,
            ...(options.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            project,
            requestId,
            request: inner,
            model: options.model,
            userAgent: "antigravity",
            requestType: "agent",
          }),
        },
        losses: losses.drain(),
      };
    },

    readUpstreamResponse(response: Response): AsyncIterable<IREvent> {
      return liftGeminiStream(response, options.model);
    },
  };
}

function trajectoryFromRequestId(requestId: string): string {
  const parts = requestId.split("/");
  return parts.length >= 2 ? (parts[parts.length - 2] as string) : requestId;
}

// ── thoughtSignature 旁路 ───────────────────────────────────────────────────

const THOUGHT_SIGNATURE_PLACEHOLDER = "skip_thought_signature_validator";
const THOUGHT_SIGNATURE_CACHE_MAX = 4096;

/**
 * **IR 的一处真实缺口，写在这里而不是藏在实现里。**
 *
 * Gemini 把跨回合的推理线索绑在每个 functionCall 的 `thoughtSignature` 上：下一轮必须把它
 * 原样挂回同一个 functionCall，否则模型丢失推理线索 → 重复规划、MALFORMED_FUNCTION_CALL、
 * 400 INVALID_ARGUMENT。占位符 `skip_thought_signature_validator` 只让上游放行，不带任何推理。
 *
 * IR 里没有它的位置：
 *   - `thinking.signature` 是 Anthropic 挂在**思考块**上的完整性凭据，宿主不同、语义不同；
 *   - `opaque` 装得下任意 wire 片段，但 `IRResponsePart` 只收 text/thinking/redactedThinking/
 *     toolCall，opaque **进不了响应回合**（`assembleResponse` 会丢弃并记 loss）；
 *   - `IRToolCall.caller` 是发起方标识，塞签名是滥用。
 *
 * 于是只能落到进程内、按 callId 索引的旁路缓存 —— callId 端到端稳定
 * （gemini functionCall.id → IR toolCall.id → 客户端 tool_use.id → 回来还是它）。
 * 每条流首次遇到签名时 lift 会 yield 一条 `loss`，让这个旁路是**可见**的。
 */
const thoughtSignatureByCallId = new Map<string, string>();

function rememberThoughtSignature(callId: string, signature: string): void {
  if (callId.length === 0 || signature.length === 0) return;
  if (thoughtSignatureByCallId.has(callId)) thoughtSignatureByCallId.delete(callId);
  thoughtSignatureByCallId.set(callId, signature);
  if (thoughtSignatureByCallId.size > THOUGHT_SIGNATURE_CACHE_MAX) {
    const oldest = thoughtSignatureByCallId.keys().next().value;
    if (oldest !== undefined) thoughtSignatureByCallId.delete(oldest);
  }
}

function recallThoughtSignature(callId: string): string | undefined {
  return thoughtSignatureByCallId.get(callId);
}

/** 测试与长驻进程重置用。 */
export function clearThoughtSignatureCache(): void {
  thoughtSignatureByCallId.clear();
}

// ── lift ───────────────────────────────────────────────────────────────────

/**
 * finishReason → IRStopReason。
 *
 * 实测只见过 STOP(1522) 与 MAX_TOKENS(80)，其余按 Gemini 公开枚举映射。
 * STOP 且本轮出过工具调用时归 `toolUse` —— Gemini 不像 Anthropic 有独立的 tool_use 终止码，
 * 这一步是**推断**，但它是唯一能让下游区分「说完了」与「等你执行工具」的办法。
 */
function mapFinishReason(reason: string, hadToolCall: boolean): IRStopReason {
  switch (reason) {
    case "STOP": return hadToolCall ? "toolUse" : "endTurn";
    case "MAX_TOKENS": return "maxTokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY": return "refusal";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "OTHER": return "error";
    default: return "endTurn";
  }
}

const RETRYABLE_FINISH = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER"]);

function mapUpstreamError(payload: unknown, httpStatus: number | null): IRUpstreamError {
  // Google 的错误体有两种：`{error:{code,message,status}}`，以及某些边缘节点回的
  // `[{error:{...}}]`（数组包一层）。两种都要认，否则 message 会退化成 "upstream error"。
  const unwrapped = Array.isArray(payload) ? payload[0] : payload;
  const holder = typeof unwrapped === "object" && unwrapped !== null
    ? unwrapped as Record<string, unknown> : {};
  const inner = typeof holder.error === "object" && holder.error !== null
    ? holder.error as Record<string, unknown> : holder;
  const message = typeof inner.message === "string" ? inner.message : "upstream error";
  const status = typeof inner.status === "string" ? inner.status : "";
  const code = typeof inner.code === "number" ? inner.code : httpStatus;

  const kind: IRUpstreamError["kind"] = (() => {
    if (status === "UNAUTHENTICATED" || status === "PERMISSION_DENIED" || code === 401 || code === 403) {
      return "permissionDenied";
    }
    if (status === "FAILED_PRECONDITION") return "permissionDenied";
    if (status === "RESOURCE_EXHAUSTED" || code === 429) {
      return /quota/iu.test(message) ? "quotaExhausted" : "rateLimited";
    }
    if (status === "UNAVAILABLE" || status === "INTERNAL" || status === "DEADLINE_EXCEEDED"
      || code === 500 || code === 502 || code === 503 || code === 504) {
      return "upstreamUnavailable";
    }
    if (status === "CANCELLED" || code === 499) return "transport";
    if (status === "INVALID_ARGUMENT" || status === "NOT_FOUND" || code === 400 || code === 404) {
      if (/token count|too (many|long)|exceeds? the (maximum|context|input)|context length/iu.test(message)) {
        return "contextLengthExceeded";
      }
      if (/safety|blocked|policy|prohibited/iu.test(message)) return "contentPolicy";
      return "invalidRequest";
    }
    return "unknown";
  })();

  return {
    kind,
    httpStatus: httpStatus ?? (typeof code === "number" ? code : null),
    message,
    retryable: kind === "rateLimited" || kind === "upstreamUnavailable" || kind === "transport",
    raw: payload,
  };
}

/**
 * usageMetadata → IRUsage。
 *
 * `promptTokenCount` **含** `cachedContentTokenCount`，所以要拆，否则将来上游一开缓存
 * 输入就被算成双份。cloudcode 私有面实测从不带 cachedContentTokenCount ——
 * 那就让 `cacheReadTokens` 保持 undefined（不变量 5 的三态：undefined = 上游不支持缓存）。
 * `thoughtsTokenCount` 已计在 `candidatesTokenCount` 里，只另填 reasoningTokens，不重复相加。
 */
function usageFrom(raw: unknown): IRUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const prompt = num(usage.promptTokenCount) ?? 0;
  const cached = num(usage.cachedContentTokenCount);
  const thoughts = num(usage.thoughtsTokenCount);
  return {
    inputTokens: cached === undefined ? prompt : Math.max(0, prompt - cached),
    outputTokens: num(usage.candidatesTokenCount) ?? 0,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(thoughts === undefined ? {} : { reasoningTokens: thoughts }),
  };
}

/**
 * ⚠ **本地 SSE 切帧，不是重复造轮子 —— `src/ir/sse.ts` 的 `iterateSse` 在这里会全军覆没。**
 *
 * 实测（2026-08-04 真实打通 cloudcode-pa）：CloudCode 的帧分隔符是 **CRLF**
 * `\r\n\r\n`，而 `iterateSse` 只找 `"\n\n"`（`parseSseBlock` 逐行剥了行尾的 `\r`，
 * 但帧边界那一步没有）。于是 `indexOf("\n\n")` 一次都不命中，整条流被攒成**一个** block，
 * 多个 JSON 首尾相接 → `tryParseJson` 失败 → 一条 `unhandled` + 一条「没等到 finishReason」
 * 的 error。症状不是报错，是**整轮内容凭空消失**。
 *
 * 这是共享原语的缺陷（HTML SSE 规范里 `\r\n\r\n` / `\n\n` / `\r\r` 都是合法的事件分隔），
 * 修它要动 `src/ir/**`，不属于本次改动范围 —— 所以这里先本地兜住，并在报告里点名。
 * `iterateSse` 修好之后，这个函数可以整个删掉换回去。
 */
async function* iterateGeminiSse(response: Response): AsyncGenerator<{ data: string; event: string | null }> {
  const body = response.body;
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = function* (final: boolean): Generator<{ data: string; event: string | null }> {
    for (;;) {
      // 三种合法分隔符都要认，取最早出现的那个。
      const candidates = ["\r\n\r\n", "\n\n", "\r\r"]
        .map((separator) => ({ separator, at: buffer.indexOf(separator) }))
        .filter((hit) => hit.at !== -1)
        .sort((a, b) => a.at - b.at);
      const hit = candidates[0];
      if (hit === undefined) break;
      const raw = buffer.slice(0, hit.at);
      buffer = buffer.slice(hit.at + hit.separator.length);
      const parsed = parseFrame(raw);
      if (parsed !== null) yield parsed;
    }
    // 上游没有以空行收尾时，残留的最后一帧仍然要发出去。
    if (!final) return;
    const tail = parseFrame(buffer);
    if (tail !== null) yield tail;
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
}

function parseFrame(raw: string): { data: string; event: string | null } | null {
  const data: string[] = [];
  let event: string | null = null;
  for (const line of raw.split(/\r\n|\n|\r/u)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length === 0 && event === null) return null;
  return { data: data.join("\n"), event };
}

type CursorKind = "text" | "thinking";

/**
 * 合成 part 边界。
 *
 * Gemini 没有 `content_block_start/stop`，parts 直接出现。这里的规则只有一条：
 * **种类一变就换块**。文本与思考各自连续累加；functionCall 是原子的，自开自闭。
 * 这是本出口的解释，不是上游的原话 —— 但它不会凭空造内容，也不会把两种内容并进同一块。
 */
class PartCursor {
  #next = 0;
  #open: { index: number; kind: CursorKind } | null = null;

  /** 需要一个该种类的块：必要时先关掉不同种类的块，返回 (index, 是否刚开) 。 */
  open(kind: CursorKind): { index: number; started: boolean; closed: number | null } {
    if (this.#open !== null && this.#open.kind === kind) {
      return { index: this.#open.index, started: false, closed: null };
    }
    const closed = this.#open === null ? null : this.#open.index;
    const index = this.#next;
    this.#next += 1;
    this.#open = { index, kind };
    return { index, started: true, closed };
  }

  /** 原子块（工具调用）自己占一个 index，并先关掉正在开的块。 */
  atomic(): { index: number; closed: number | null } {
    const closed = this.#open === null ? null : this.#open.index;
    this.#open = null;
    const index = this.#next;
    this.#next += 1;
    return { index, closed };
  }

  close(): number | null {
    const closed = this.#open === null ? null : this.#open.index;
    this.#open = null;
    return closed;
  }
}

async function* liftGeminiStream(response: Response, fallbackModel: string): AsyncGenerator<IREvent> {
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapUpstreamError(tryParseJson(text) ?? text, response.status) };
    return;
  }

  const cursor = new PartCursor();
  const state = {
    started: false,
    hadToolCall: false,
    signatureLossReported: false,
    finishReason: null as string | null,
    usage: null as IRUsage | null,
    toolCallSeq: 0,
    blocked: null as IRUpstreamError | null,
  };

  const contentType = response.headers.get("content-type") ?? "";
  const chunks: AsyncIterable<{ payload: unknown; rawText: string; event: string | null }> =
    contentType.includes("text/event-stream")
      ? (async function* () {
          for await (const frame of iterateGeminiSse(response)) {
            yield { payload: tryParseJson<unknown>(frame.data), rawText: frame.data, event: frame.event };
          }
        })()
      // 上游只有流式端点，但 4xx 之外仍可能回一次性 JSON（如经过代理被缓冲）。
      // 走同一套 chunk 处理，不再长出第二条解析路径。
      : (async function* () {
          const text = await response.text();
          yield { payload: tryParseJson<unknown>(text), rawText: text, event: null };
        })();

  for await (const chunk of chunks) {
    if (chunk.payload === null || typeof chunk.payload !== "object") {
      yield { kind: "unhandled", rawType: chunk.event ?? "<unparseable>", raw: chunk.rawText };
      continue;
    }
    const envelope = chunk.payload as Record<string, unknown>;

    // 流中错误：Google 会在 200 的 SSE 里直接塞 `{error:{...}}`。
    if (typeof envelope.error === "object" && envelope.error !== null) {
      state.finishReason = state.finishReason ?? "ERROR";
      if (state.usage !== null) yield { kind: "usage", usage: state.usage };
      const closed = cursor.close();
      if (closed !== null) yield { kind: "partEnd", index: closed };
      yield { kind: "error", error: mapUpstreamError(envelope, null) };
      return;
    }

    const inner = envelope.response;
    const body = typeof inner === "object" && inner !== null
      ? inner as Record<string, unknown>
      : envelope;
    const hasCandidates = Array.isArray(body.candidates);
    const hasUsage = typeof body.usageMetadata === "object" && body.usageMetadata !== null;
    const hasFeedback = typeof body.promptFeedback === "object" && body.promptFeedback !== null;
    if (!hasCandidates && !hasUsage && !hasFeedback) {
      // 三样都没有 = 上游换了形状。不变量 4：不能静默吞掉。
      yield { kind: "unhandled", rawType: "<gemini-chunk>", raw: envelope };
      continue;
    }

    if (!state.started) {
      state.started = true;
      const modelVersion = typeof body.modelVersion === "string" && body.modelVersion.length > 0
        ? body.modelVersion : fallbackModel;
      yield { kind: "messageStart", model: modelVersion };
    }

    // 每个 chunk 都带累计 usage。只留最新的，在终止前发一次 —— 每 chunk 发一条只会让
    // 下游反复覆盖同一个变量。
    const usage = usageFrom(body.usageMetadata);
    if (usage !== null) state.usage = usage;

    if (hasFeedback) {
      const feedback = body.promptFeedback as Record<string, unknown>;
      if (typeof feedback.blockReason === "string") {
        state.blocked = {
          kind: "contentPolicy",
          httpStatus: null,
          message: `prompt blocked upstream: ${feedback.blockReason}`,
          retryable: false,
          raw: feedback,
        };
        state.finishReason = state.finishReason ?? feedback.blockReason;
      }
    }

    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      yield {
        kind: "loss",
        loss: {
          stage: "lift", provider: PROVIDER, path: "$.response.candidates", kind: "dropped",
          detail: `上游返回 ${candidates.length} 个 candidate，IR 的响应只有一个 assistant 回合，仅取第一个`,
        },
      };
    }
    const candidate = candidates[0] as Record<string, unknown> | undefined;
    if (candidate === undefined) continue;

    // 终止判定必须在 parts 守卫**之前**：实测带 finishReason 的 candidate 全部同时带 parts，
    // 所以现在提前读没有影响；但上游一旦发出「只有 finishReason、没有 content」的收尾块，
    // 守卫在前就会把它 continue 掉，白白当成掐断。
    if (typeof candidate.finishReason === "string" && candidate.finishReason.length > 0) {
      state.finishReason = candidate.finishReason;
    }

    const content = typeof candidate.content === "object" && candidate.content !== null
      ? candidate.content as Record<string, unknown> : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];

    for (const rawPart of parts) {
      if (typeof rawPart !== "object" || rawPart === null) {
        yield { kind: "unhandled", rawType: "<gemini-part>", raw: rawPart };
        continue;
      }
      const part = rawPart as Record<string, unknown>;

      // thoughtSignature 是**兄弟字段**，可能挂在 functionCall 上、挂在 text 上，
      // 也可能自己带个空 text 单独出现（实测 300 次 {text,thoughtSignature}）。先摘下来。
      const signature = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
        ? part.thoughtSignature : null;

      if (typeof part.functionCall === "object" && part.functionCall !== null) {
        const call = part.functionCall as Record<string, unknown>;
        const name = typeof call.name === "string" ? call.name : "";
        state.toolCallSeq += 1;
        const id = typeof call.id === "string" && call.id.length > 0
          ? call.id
          // 实测 4 次 functionCall 不带 id。合成一个确定性 id 而不是随机串：
          // 它要端到端稳定（下一轮回来还要靠它找 thoughtSignature）。
          : `gemini_call_${state.toolCallSeq}_${name}`;
        const args = typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
          ? call.args as Record<string, unknown> : {};

        if (signature !== null) {
          rememberThoughtSignature(id, signature);
          if (!state.signatureLossReported) {
            state.signatureLossReported = true;
            yield { kind: "loss", loss: thoughtSignatureLoss() };
          }
        }

        const { index, closed } = cursor.atomic();
        if (closed !== null) yield { kind: "partEnd", index: closed };
        state.hadToolCall = true;
        // partStart 给空入参、入参走 delta：与 Anthropic 出口的流式形状一致，
        // 且 chat_completions 的流式 encoder **只**从 delta 取 arguments（partStart 里的
        // 入参它根本不读），少发这条 delta 会让那条路上的工具参数变成空串。
        yield {
          kind: "partStart", index,
          part: { kind: "toolCall", call: { id, toolRef: { group: null, name }, input: { kind: "json", value: {} } } },
        };
        yield { kind: "partDelta", index, delta: { kind: "toolInputJson", json: JSON.stringify(args) } };
        yield { kind: "partEnd", index };
        continue;
      }

      if (part.thought === true) {
        const text = typeof part.text === "string" ? part.text : "";
        if (signature !== null && !state.signatureLossReported) {
          state.signatureLossReported = true;
          yield { kind: "loss", loss: thoughtSignatureLoss() };
        }
        if (text.length === 0) continue;
        const { index, started, closed } = cursor.open("thinking");
        if (closed !== null) yield { kind: "partEnd", index: closed };
        if (started) yield { kind: "partStart", index, part: { kind: "thinking", text: "" } };
        yield { kind: "partDelta", index, delta: { kind: "thinking", text } };
        continue;
      }

      if (typeof part.text === "string") {
        if (signature !== null && !state.signatureLossReported) {
          state.signatureLossReported = true;
          yield { kind: "loss", loss: thoughtSignatureLoss() };
        }
        // `{text:""}`（收尾块）与 `{text:"",thoughtSignature}` 都不该开出一个空块。
        if (part.text.length === 0) continue;
        const { index, started, closed } = cursor.open("text");
        if (closed !== null) yield { kind: "partEnd", index: closed };
        if (started) yield { kind: "partStart", index, part: { kind: "text", text: "" } };
        yield { kind: "partDelta", index, delta: { kind: "text", text: part.text } };
        continue;
      }

      if (signature !== null) {
        // 只有签名、别的什么都没有：不是内容，但也不是未知形态。
        if (!state.signatureLossReported) {
          state.signatureLossReported = true;
          yield { kind: "loss", loss: thoughtSignatureLoss() };
        }
        continue;
      }

      // 落到这里的是上游新加的形状（inlineData 图片输出、executableCode、fileData…）。
      // 不变量 2/4：显式装箱，rawType 带上键集，协议漂移自己会冒头。
      yield { kind: "unhandled", rawType: `<gemini-part:${Object.keys(part).sort().join("+")}>`, raw: part };
    }
  }

  const closed = cursor.close();
  if (closed !== null) yield { kind: "partEnd", index: closed };
  if (state.usage !== null) yield { kind: "usage", usage: state.usage };

  if (state.blocked !== null) {
    yield { kind: "error", error: state.blocked };
    return;
  }

  // Gemini 流的终止信号就是 candidate.finishReason，没有 message_stop 这类终止帧。
  // 一个都没等到 = 流被掐断。此前照样收尾的话，客户端看到的是「200 但空」，
  // 与「模型没话说」不可区分，只能盲重试到 retry cap。
  if (state.finishReason === null) {
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a finishReason; the turn is truncated",
        raw: null,
      },
    };
    return;
  }

  if (RETRYABLE_FINISH.has(state.finishReason)) {
    // MALFORMED_FUNCTION_CALL：模型想调工具但 JSON 写坏了，既没有合法 functionCall 也没有正文。
    // 这不是一次正常收尾，报成 endTurn 会让调用方拿到一个静默的空回合。
    yield {
      kind: "error",
      error: {
        kind: "unknown", httpStatus: null, retryable: true,
        message: `upstream finished with ${state.finishReason}; the turn produced no usable content`,
        raw: { finishReason: state.finishReason },
      },
    };
    return;
  }

  yield { kind: "messageStop", reason: mapFinishReason(state.finishReason, state.hadToolCall) };
}

function thoughtSignatureLoss(): IRLoss {
  return {
    stage: "lift",
    provider: PROVIDER,
    path: "$.response.candidates[0].content.parts[].thoughtSignature",
    kind: "dropped",
    detail: "Gemini 的 thoughtSignature 挂在 functionCall/text part 上，与 Anthropic 挂在思考块上的 "
      + "thinking.signature 不同构；IREvent 与 IRResponsePart 都没有承载它的位置"
      + "（opaque 进不了响应回合），只能按 tool call id 存进进程内旁路缓存供下一轮回填",
  };
}
