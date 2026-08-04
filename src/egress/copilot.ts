/**
 * GitHub Copilot 出口。**它不是新协议**：数据面就是 Anthropic Messages wire ——
 * `POST ${apiBase}/v1/messages`、`anthropic-version: 2023-06-01`、同一套 SSE 事件。
 *
 * 所以本文件里**没有一行**「IR → Anthropic Messages body」的投影：那份投影是
 * `anthropic.ts` 的授权定义，这里只提供 `AnthropicMessagesDialect` 的四件事 ——
 * 端点、身份头、能力声明、方言复核。复制一份投影过来会让两边各自演化而不报错，
 * 症状不是编译失败，是两家上游收到的 body 慢慢变得不一样却没人发现。
 *
 * 与原生 Anthropic 的三处真实差别（逐条实证见下文）：
 *   1. **base URL 是每个凭据自己的** —— 从 `https://api.github.com/copilot_internal/user`
 *      的 `endpoints.api` 取，没有固定值，所以它是 options 的入参而不是常量。
 *   2. **鉴权是两段式且会过期** —— GitHub OAuth device flow 拿 `gho_` token，
 *      再换短期 Copilot session token；生产**两头都带**（见 `resolveTarget`）。
 *   3. **必须带一组身份头** —— 缺 `copilot-integration-id` 鉴权失败，
 *      缺 `x-github-api-version` 会 404；`anthropic-beta` 必须**剥掉**（上游 Bedrock 对
 *      新 beta 回 400）。因此身份头是构造出来的，客户端头压不过它。
 *
 * wire 知识全部来自生产在用的实现，不凭印象：
 *   - `cc_proxy_unified/packages/copilot_protocol/src/wire.ts`（常量，实抓还原自 Copilot CLI 1.0.73）
 *   - `cc_proxy_unified/packages/copilot_protocol/src/egress.ts`（`decorateCopilotEgress` 的头集与剥离表）
 *   - `cc_proxy_unified/packages/relay/src/copilot_messages_relay.ts`（端点、两段式鉴权、非流式分支）
 *   - `cc_proxy_unified/packages/relay/src/copilot_request_projection.ts`（能力表，判据是上游 400 原文）
 *   - `.corpus/requests.ndjson` 里 **606 条 `accountType:'copilot'` 的真实生产请求**
 *     （本文件所有带计数的能力判据都出自它，是 Copilot 侧的行为实证而不是对原生 Anthropic 的类推）
 */
import {
  createAnthropicMessagesUpstream,
  type AnthropicMessagesDialectReview,
  type AnthropicMessagesTarget,
} from "./anthropic.ts";
import type { ValueSource } from "./gemini_cloudcode.ts";
import type {
  IRBuildProblem, IRCapability, IREgress, IRLoss, IRRequest,
} from "../ir/types.ts";

const PROVIDER = "copilot";

// ── 身份头常量 ──────────────────────────────────────────────────────────────
//
// 实抓还原自 Copilot CLI 1.0.73（生产 `copilot_protocol/src/wire.ts` 的同一组值）。
// 本仓库零依赖、跨仓库 import 不存在，所以只能重述 —— 每条都标出「缺了会怎样」，
// 让它是一份带判据的抄件而不是一组来历不明的魔法字符串。

/** 缺则鉴权失败。 */
const INTEGRATION_ID = "copilot-developer-cli";
/** 缺则 `/models/session` 404。 */
const API_VERSION = "2026-07-01";
const EDITOR_VERSION = "copilot/1.0.73";
const USER_AGENT = "copilot/1.0.73 (linux v24.16.0) term/unknown";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 客户端头里**绝不透传**给 Copilot 的那些。
 *
 * `anthropic-beta` 是这张表上唯一反直觉的一条：真实 Copilot 客户端打 `/v1/messages`
 * 时不发它（实抓头集只有 `anthropic-version`），而上游 Bedrock 对新版 Claude Code 带来的
 * beta（如 `advisor-tool-2026-03-01`）直接回 400。剥离是「按真实流量整形」，不是偏好。
 *
 * 鉴权头（`authorization` / `x-api-key` / `copilot-session-token`）由本出口自己构造：
 * 让客户端的 key 漏到上游是另一类事故。
 */
const STRIPPED_FORWARD_HEADERS = new Set([
  "host", "content-length", "connection",
  "authorization", "x-api-key", "copilot-session-token", "anthropic-beta",
]);

// ── 能力声明 ────────────────────────────────────────────────────────────────
//
// 判据只有一条，且它对 Copilot **单独成立**，不是「原生 Anthropic 支持所以 Copilot 也支持」：
// `.corpus/requests.ndjson` 里 606 条请求的 `accountType` 就是 `copilot` —— 它们是真实
// Claude Code 经生产 Copilot 管线打出去的流量。**在这批流量里真实出现过的字段进
// `supports`，出现 0 次的进 `lossy`（结构实证），观测到被上游拒的进 `lossy` 且在
// `review` 里显式删字段留痕。** 计数逐条写在下面。
//
// 反面教训（生产 `copilot_request_projection.ts` 2026-07-27 记录）：
// 「7 天遥测里 context_management 相关错误 0 次」**不能**推出上游接受它 ——
// 上游只报第一个校验失败，另一个字段的错误把它整段盖住了。所以这里用的是
// 「客户端真的发过」+「上游 400 原文枚举过接受集」两种正面证据，不用「没报错」。

const SUPPORTED = [
  // 486/606 条 stream:true —— 生产数据面每天在跑 SSE。
  "stream",
  // 120/606 条 stream 非 true；生产 relay 为此有独立的非流式分支，并用完整 Anthropic
  // Message schema 校验响应体（`validateCopilotNonStreamingMessage`）。
  "nonStream",
  // 566/606 带 system（418 数组形态 + 148 字符串形态）。
  "systemPrompt",
  // 13838 个 tool_use / 13838 个 tool_result 分布在多轮历史里。
  "multiTurn",
  // 消息里 8 个 image 块；另有 94 个图片落在 tool_result 内（见 toolResultImage）。
  // 生产能力表 message_image=true，判据是上游 400 原文。
  "image",
  // 556/606 带 thinking（adaptive 350 / disabled 206）；生产 relay 在投影 effort 时
  // 还会显式写 `thinking:{type:'adaptive'}`。
  "thinking",
  // 2959 个 thinking 块**全部**带 signature 并被上游受理。签名不被接受会 400 而不是静默 ——
  // 这是行为实证，不是「字段存在」。
  "thinkingSignature",
  // 353/606 带 `output_config.effort`；模型目录里每个模型自报 reasoning_effort 阶梯。
  "reasoningEffort",
  // 517/606 带 tools；生产能力表 tool_custom=true（'custom' 出现在每一份观测到的上游白名单里）。
  "toolFunction",
  // 上游拒绝一个 tool type 时会**枚举它接受的全部 tag**（2026-07-27 生产 400 原文）：
  //   bash_20250124 / code_execution_* / custom / memory_20250818 / text_editor_* /
  //   tool_search_tool_bm25* / tool_search_tool_regex* / web_fetch_* / web_search_*
  // 近 7 天对这些 tag 的拒绝计数 0–2 次。**唯一的例外是 computer_***（7 天 14353 次拒绝，
  // 语料里那 1 个内建工具正是它）—— 那一条在 `review` 里带精确路径拒绝，
  // 这正是「准入看能力类别、写出看具体请求」的分工。
  "toolBuiltin",
  // Anthropic wire 默认允许并行；语料里一条 assistant 回合多个 tool_use 是常态。
  "toolParallel",
  // 169/606 带 tool_choice，其中 143 条是 `{type:'tool',name}`。
  "toolChoiceSpecific",
  // 94 个图片块落在 tool_result 内；生产能力表 tool_result_image=true。
  "toolResultImage",
  // 699 个 tool_result 带 is_error:true。
  "toolResultError",
  // 3/606 带 `output_config.format`。计数很薄，但它是**发生过**而不是推断出来的；
  // 与之相对，下面 lossy 里那几条是 0 次。
  "structuredOutput",
  // 349/606 的消息块带 cache_control 并被受理。
  // **诚实边界**：这证明的是「上游接受这个断点」，不是「缓存真的命中了」——
  // 命中与否要看响应侧的 cache_read_input_tokens，出口这一侧看不到。
  // 仍放 supports 而不是 lossy：放 lossy 等于断言「Copilot 比原生更差」，
  // 那同样是一个没有证据的断言，而且会给 58% 的真实流量各记一条无依据的 degraded。
  "cacheBreakpoint",
  // 606/606 —— Anthropic wire 必填，每条都带。
  "maxOutputTokens",
  // 9/606。
  "stopSequences",
  // 25/606。
  "temperature",
] as const satisfies readonly IRCapability[];

/**
 * 能承载但有损，或**观测为 0**。两类都在这里，因为它们对准入的处置相同：放行 + 强制留痕。
 *
 * 元素类型是 `Exclude<IRCapability, 已 supports 的>`：两个集合必须不相交 ——
 * 重叠时准入先命中 supports 直接放行，下面写的留痕就一条都不会发生。
 */
const LOSSY = [
  // 606 条里 **0** 个 document 块，生产能力表里也根本没有 document 这一类。
  // wire 上有位置（与原生同一份投影编出同一个块），但没有任何一次真实调用证明
  // Copilot 会照它行事 —— 结构实证只能进 lossy（ARCHITECTURE §7）。
  "document",
  // 0 条 `thinking:{type:'enabled',budget_tokens}`（adaptive 350 / disabled 206，加起来就是全部）。
  // 且生产 relay 在有 effort 时会把 thinking 整个改写成 adaptive，budget 从未上过这条 wire。
  "reasoningBudget",
  // 与原生同源的编译事实：Anthropic wire 没有自由文本入参工具，共享投影把它包成单字段 JSON schema。
  "toolFreeform",
  // 与原生同源的编译事实：没有 namespace 概念，共享投影把分组拍进工具名。
  "toolGroup",
  // **唯一一条有「被拒」实证的能力**：2026-07-27 生产 canary（真实 Claude Code 经
  // copilot-only Key）带 context_management → 400 "context_management: Extra inputs are
  // not permitted"；同批次去掉它、其余字段完全相同 → 200。
  // 语料里 147/606 条带它（全部是 clear_thinking_20251015）—— 不删就是四分之一的真实流量必死。
  // 删字段是**编译事实**（目标 wire 真的没有这个位置），不是策略：换一个调用方也不会想要 400。
  "contextEdit",
  // 0 条带 service_tier。而且共享投影本来就不写 service_tier 这个字段（原生也一样），
  // 所以它在这条 wire 上是「进来了但没出去」——放行并留痕，不假装承载。
  "serviceTier",
  // 各 0 条。字段在 Anthropic wire 上有位置、共享投影会原样发出去，
  // 但 Copilot 侧一次真实调用都没有 —— 结构实证，进 lossy。
  "topP", "topK",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

// ── 凭据与 options ──────────────────────────────────────────────────────────

/**
 * Copilot 出口的依赖，**全部经工厂参数注入**：函数体里不读环境变量、不读本机凭据文件、
 * 不碰任何全局。三个凭据位都是 `ValueSource`（常量或回调），因为它们的生命周期不同：
 *
 *   - `sessionToken` 是**短期 JWT，会过期**，必须能每条请求重新取（回调）；
 *   - `apiBase` 是**每个凭据自己的**（`/copilot_internal/user` 的 `endpoints.api`），
 *     不是全局常量，换一个账号就换一个值；
 *   - `githubToken` 是 device flow 拿到的 `gho_`，相对长寿但也会被吊销。
 *
 * **device flow 与 session token 交换故意不在这个出口里。** 判据是本仓库的边界：
 * agent-ir 只做协议翻译与准入裁决，不做账号选择、配额与重试编排。设备码轮询是一个
 * 带人工交互、需要落库、跨请求跨进程共享的**账号生命周期**过程 —— 把它塞进出口会让
 * 「一个上游模型 id 一个出口实例」的缓存变成一个隐形的凭据池，而真正的凭据池
 * （刷新、冷却、多账号轮换）在调用方手里。出口要的只是「现在给我一个能用的 token」，
 * 这正是 `ValueSource<string>` 表达的东西。
 */
export interface CopilotUpstreamOptions {
  /** 出站模型名。Copilot 只接受 session token 里 available_models 清单内的 id，映射由调用方决定。 */
  readonly model: string;
  /** 数据面 base URL：取自该凭据的 `/copilot_internal/user` → `endpoints.api`。 */
  readonly apiBase: ValueSource<string>;
  /** `copilot-session-token`（短期 JWT，**不带 Bearer**）。 */
  readonly sessionToken: ValueSource<string>;
  /**
   * `authorization: Bearer <gho_…>`。生产**两头都带**：relay 的调用点把 gho 作为
   * accessToken 交给传输层注入 Bearer，同时 headers 里带 session token。
   * （传输层里有一句更早的注释说 Copilot「不带 Authorization Bearer」，与调用点矛盾；
   * 以调用点为准 —— 那是真正发出去的字节。）
   */
  readonly githubToken: ValueSource<string>;
  /** 允许透传的客户端头。身份头与鉴权头**压不过**本出口构造的那些，见 `STRIPPED_FORWARD_HEADERS`。 */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly integrationId?: string;
  readonly editorVersion?: string;
  readonly apiVersion?: string;
  readonly userAgent?: string;
  readonly anthropicVersion?: string;
}

async function resolveSource<T>(source: ValueSource<T>): Promise<T> {
  return typeof source === "function" ? await (source as () => T | Promise<T>)() : source;
}

/**
 * 空凭据是**抛**而不是记 loss：出口拿不到 token 是配置/凭据池的故障，不是这条请求有损。
 * 记 loss 会让它变成一个「成功但打不通」的 wire，症状落到上游的 401 上，
 * 排查时看到的是「Copilot 鉴权失败」而不是「网关根本没拿到 token」。
 */
async function resolveRequired(source: ValueSource<string>, field: string): Promise<string> {
  const value = (await resolveSource(source)).trim();
  if (value.length === 0) {
    throw new Error(`copilot egress: options.${field} resolved to an empty value`);
  }
  return value;
}

// ── 出口 ────────────────────────────────────────────────────────────────────

/** `computer_*` 是唯一有硬拒绝实证的内建工具族，识别按前缀而不是枚举具体日期版本。 */
function isRejectedBuiltin(builtin: string): boolean {
  return builtin === "computer" || builtin.startsWith("computer_");
}

/**
 * 方言复核：删掉上游没有位置的字段，拒绝上游必拒的工具。两者都**只**处理有实证的那一条，
 * 不追求穷举上游的接受集 —— 生产实测同一账号在不同 endpoint 上拿到的白名单长度都不同，
 * 穷举必然滞后。本表判不了的一律交给上游裁决。
 */
function reviewCopilotBody(
  body: Record<string, unknown>,
  request: IRRequest,
): AnthropicMessagesDialectReview {
  const losses: Array<Omit<IRLoss, "stage" | "provider">> = [];
  const problems: IRBuildProblem[] = [];

  request.conversation.toolset.tools.forEach((tool, index) => {
    if (tool.kind !== "builtin" || !isRejectedBuiltin(tool.builtin)) return;
    problems.push({
      kind: "unrepresentablePart",
      path: `$.conversation.toolset.tools[${index}]`,
      detail: `Copilot rejects the builtin tool type '${tool.builtin}': the upstream enumerates its `
        + "accepted tool tags in the 400 body and computer_* is on none of them (14353 rejections "
        + "in 7 days of production). Rewriting it into a custom tool would invent a tool "
        + "description the client never wrote (compose repair to choose that rewrite deliberately)",
    });
  });

  if (!Object.hasOwn(body, "context_management")) {
    return { ...(losses.length === 0 ? {} : { losses }), ...(problems.length === 0 ? {} : { problems }) };
  }
  const projected = { ...body };
  delete projected.context_management;
  losses.push({
    path: "$.intent.contextEdits",
    kind: "dropped",
    detail: "Copilot rejects context_management with 400 'Extra inputs are not permitted' "
      + "(2026-07-27 canary: same request without it returns 200); the edits are dropped, "
      + "which only costs the upstream-side trimming and changes nothing in what the model sees",
  });
  return { body: projected, losses, ...(problems.length === 0 ? {} : { problems }) };
}

export function createCopilotUpstream(options: CopilotUpstreamOptions): IREgress {
  const integrationId = options.integrationId ?? INTEGRATION_ID;
  const editorVersion = options.editorVersion ?? EDITOR_VERSION;
  const apiVersion = options.apiVersion ?? API_VERSION;
  const userAgent = options.userAgent ?? USER_AGENT;
  const anthropicVersion = options.anthropicVersion ?? ANTHROPIC_VERSION;

  // 客户端头先铺、身份头后盖：客户端**不可能**用一个同名头顶掉 Copilot 身份，
  // 也不可能把剥掉的 anthropic-beta 塞回去（生产 `decorateCopilotEgress` 同序）。
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    if (!STRIPPED_FORWARD_HEADERS.has(name.toLowerCase())) forwarded[name] = value;
  }

  async function resolveTarget(): Promise<AnthropicMessagesTarget> {
    const [apiBase, sessionToken, githubToken] = await Promise.all([
      resolveRequired(options.apiBase, "apiBase"),
      resolveRequired(options.sessionToken, "sessionToken"),
      resolveRequired(options.githubToken, "githubToken"),
    ]);
    return {
      url: `${apiBase.replace(/\/$/u, "")}/v1/messages`,
      headers: {
        ...forwarded,
        "content-type": "application/json",
        // 两段式鉴权的两头，缺任何一头生产都不通。
        authorization: `Bearer ${githubToken}`,
        "copilot-session-token": sessionToken,
        "copilot-integration-id": integrationId,
        "editor-version": editorVersion,
        "x-github-api-version": apiVersion,
        "user-agent": userAgent,
        "anthropic-version": anthropicVersion,
        // 生产恒发这两个，且与流式与否无关（非流式响应照样正确返回整段 JSON）。
        "x-initiator": "user",
        "x-interaction-type": "conversation-user",
        accept: "text/event-stream",
      },
    };
  }

  return createAnthropicMessagesUpstream({
    provider: PROVIDER,
    model: options.model,
    supports: SUPPORTED,
    lossy: LOSSY,
    resolveTarget,
    review: reviewCopilotBody,
  });
}
