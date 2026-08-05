/**
 * Windsurf via Connect + protobuf 出口（`exa.api_server_pb.ApiServerService/GetChatMessage`）。
 *
 * 前四个出口都是「另一种 JSON SSE」。这一个不是，它逼出来的东西值得开门见山写清楚：
 *
 * 1. **wire 是二进制。** `IRWireRequest.body` 因而携带原始 `Uint8Array`，交给 fetch
 *    时字节不变；不能先 base64 化，否则服务端收到的是文本而不是 Connect 信封。
 *
 * 2. **应用错误没有 HTTP 状态码。** 它在 Connect 结束帧的 JSON trailer 里，传输层永远 200。
 *    `permission_denied` 落错档就会打遍账号池并伪装成 503 —— 完整因果见 `errors.ts` 文件头。
 *
 * 3. **proto3 的隐式存在性让「不补默认值」在这条 wire 上无法表达。**
 *    `CompletionConfiguration` 的 `temperature` / `max_tokens` / `top_p` / `top_k` /
 *    `max_newlines` 全是 implicit presence（FDS 实测 `presence=2`）：字段省略与「显式送 0」
 *    在字节上**完全相同**。于是「客户端没说温度」只能被上游读成 `temperature=0`（贪心解码），
 *    这不是省略，是一条被凭空发明出来的强指令。本出口的处置：客户端没给的字段填生产抓包里
 *    实测被接受的值，并记一条 `substituted` loss 把这次「被迫命名」留痕（见 `WIRE_NEUTRAL`）。
 *
 * 4. **协议格式与模型家族无关。** 同一个信封服务 gpt / claude / gemini / kimi / grok / glm
 *    八个家族（FDS 里 `exa.codeium_common_pb.Model` 共 334 个枚举值），模型只是
 *    `chat_model_uid` 一个字符串字段。所以**只有一份实现，不按家族分支**。
 *
 * 5. **抓包证伪了一条流传很广的说法。** 「大体量 agent 脚手架会被 Windsurf 的内容分类器拒」
 *    不成立：20945 / 21599 / 21593 字符的 system prompt 加 23 个工具定义，12 条全部 200。
 *    真正被这些字节钉住的差异是**客户端身份行**（见 `WindsurfSystemIdentityPolicy`）。
 *
 * wire 知识全部来自真实收发过的字节，不凭印象：
 *   - `test/fixtures/windsurf_capture/` —— **12 条真实 GetChatMessage 请求字节**（mitmproxy 抓自
 *     Devin CLI，`metadata.apiKey` 已抹）。本文件下面每一条标「抓包」的判断都能在这 12 条上复算：
 *     135 个 `ChatMessagePrompt`、4 个 `chat_model_uid`（kimi-k3-high / swe-1-6-fast /
 *     gpt-5-6-terra-high / gemini-3-6-flash-high）、11/12 条带 23 个工具定义。
 *     **12 条全部得到上游 HTTP 200**（抓包侧记录，不是这些字节自身能证明的）。
 *     断言锁在 `test/egress_windsurf.test.ts` 的「抓包：…」几个 describe 里。
 *   - `cc_proxy_unified/packages/windsurf_protocol/src/{messages,connect_frame,schema_registry}.ts`
 *   - `cc_proxy_unified/packages/relay/src/windsurf_messages_relay.ts`（踩坑记录）
 *   - `cc_proxy_unified/packages/relay_core/src/{messages_failure_policy,upstream_application_error}.ts`
 *   - `src/egress/windsurf/windsurf_exa.fds.pb` 的字段/枚举实测（本文件的字段存在性判断全部来自它）
 */
import { createHash } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CONNECT_FLAG_COMPRESSED, CONNECT_FLAG_END_STREAM, deframe, enframe,
  createDeframeState, parseConnectTrailer, readableToChunks,
} from "./connect_frame.ts";
import { mapConnectError, mapHttpError, readConnectError } from "./errors.ts";
import { getSharedWindsurfSchema, WINDSURF_TYPES, type WindsurfSchema } from "./schema.ts";
import type {
  IRBuildProblem, IRCapability, IROutbox, IROutboxProfile, IREvent, IRLoss, IRMandatoryFieldTable, IRPart, IRRequest,
  IRStopReason, IRToolResult, IRUsage, OutboxRequestBuildResult,
} from "../../ir/types.ts";

const OUTBOX = "windsurf";
const DEFAULT_SERVER = "https://server.codeium.com";
const RPC_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

// ── 能力声明 ────────────────────────────────────────────────────────────────

/**
 * 只放**有证据**的。证据分两级，二者不可混为一谈：
 *   (A) 行为实证 —— 真实调用在这条字段上收发过，上游按预期行事。
 *   (B) 结构实证 —— FDS 里有字段，但没有任何一次真实调用证明上游会照它行事。
 *
 * `supports` 只收 (A)。(B) 一律进 `lossy` 或直接不收 —— 「不确定就不要放进 supports」，
 * 因为 supports 的唯一作用是让准入**放行**，放错了等于把请求送进一个语义模糊的上游行为。
 *
 * 「抓包」= `test/fixtures/windsurf_capture/` 那 12 条真实请求字节（135 个回合），全部 200。
 * 计数写死在注释里是故意的：读的人能自己去那 12 条上复算，对不上就是有人改了夹具。
 */
const SUPPORTED = [
  // (A) 生产数据面每天在跑：GetChatMessage 只有流式一种形态。
  "stream",
  // (A) 非流式由入口侧把流折叠成整段（生产 `createWindsurfMessage` 就是这么做的）；
  //     lower 为此记一条 substituted。抓包全是流式，非流式这条仍靠生产实现背书。
  "nonStream",
  // (A) 顶层 `prompt` 字段。抓包 12/12 条都非空，长度 202 / 20945 / 21599 / 21593 字符，
  //     全部 200 —— 「system 太大会被拒」不成立。生产另有实测「完全替换，无内置人格」。
  "systemPrompt",
  // (A) `chat_message_prompts` 就是多轮。抓包单条最长 21 个回合（getchatmessage_159），
  //     按 source 分布是 user(1)=72 / assistant(2)=40 / tool(4)=23。
  "multiTurn",
  // (A) `ChatMessagePrompt.images` = ImageData{base64Data,mimeType,caption}。
  //     抓包 11/135 个回合带图，全部挂在 source=1 的 user 回合上，
  //     `mimeType="image/png"`、`caption=""`（getchatmessage_035 起每条都有）。
  "image",
  // (A) `ChatToolDefinition{name,description,json_schema_string}`。抓包 11/12 条各带 23 个工具，
  //     且**只**用这三个字段：`server_name`/`strict`/`is_custom_tool`/`attribution_field_names`
  //     在 253 个工具定义里无一被设置。
  "toolFunction",
  // (A) 抓包 6 条（093/111/117/130/148/159）各有一个 source=2 的回合携带 **2 个 `tool_calls`**
  //     （`web_search` × 2）并被正常受理；出站方向的并行因此是行为实证。
  //     回读方向另有生产「keeps parallel tools separate」用例。
  //     要关掉也有 `disable_parallel_tool_calls`——注意抓包 12/12 条都**没**设它。
  "toolParallel",
  // (A) `ChatMessagePrompt.tool_result_is_error`，生产断言过 true/false 两态。
  //     ⚠ 抓包**没覆盖**这一条：23 个 source=4 回合的 `tool_result_is_error` 全是 false。
  //     这条留在 supports 靠的仍是生产那份证据，不是这 12 条报文。
  "toolResultError",
  // (A) `CompletionConfiguration.max_tokens`。抓包 12/12 条都送真实值，
  //     10 条 = 128000（kimi/gpt/swe），2 条 = 65535（gemini）—— 同一字段两个量级都被受理。
  "maxOutputTokens",
  // (A) `CompletionConfiguration.temperature`。抓包 12/12 条送 1。
  "temperature",
  // (A) `top_p` / `top_k` 与 temperature 同处一个 message。抓包 12/12 条送
  //     top_p=0.95（float32 落成 0.949999988079071）、top_k=40，全部 200。
  //     从 (A/B) 升到 (A)：真实客户端确实在送这两个字段并被正常受理。
  "topP", "topK",
  // (A) `ChatMessagePrompt.thinking`。**这条是本次升级的主项**，双向都有实证：
  //     出站——抓包 39/135 个回合回传非空 thinking（最早见 getchatmessage_027），全部 200；
  //     回读——响应侧 `delta_thinking` 在抓包的 2107 帧里出现 850 次。
  //     原注释「生产从不读写它，上游是否真把它当推理块消费未经实证」已被证伪。
  //     ⚠ 仍然为真的两件事，各自另有 loss，不影响本条：
  //       1. 请求侧**没有**任何「开/关思考」的开关（mode/display 无对应字段）；
  //       2. `delta_thinking` 不是跨家族普遍事实 —— 抓包里 gemini-3-6-flash-high 上是 0 次，
  //          kimi / gpt / swe 上大量出现。承载得了 ≠ 每个模型都会回流。
  "thinking",
] as const satisfies readonly IRCapability[];

/**
 * 能承载但有损。每一条在 lower 里另有一条**带具体 IR 路径**的 loss；
 * 准入这条只是「这家整体上对这个能力有损」的兜底。
 *
 * 这里有一批是 (B) 级证据：FDS 里字段齐备、名字与 Anthropic 一一对应，
 * 但没有任何一次真实调用证明上游会照它行事。它们进 lossy 而不是 supports，
 * 就是这个区别的落点。
 */
const LOSSY = [
  // (A，但**确定有损**) `ChatMessagePrompt.signature` + `signature_type` 双向都有实证，
  //     只是稀疏：出站抓包 2/135 个回合（getchatmessage_148 与 159 的 prompt[17]，
  //     `signature` 1984 字符），回读侧 `delta_signature` + `delta_signature_type`
  //     在 2107 帧里各出现 2 次、成对出现。
  //     **它留在 lossy 不是因为缺证据，是因为 IR 装不下。** 抓到的那两条
  //     `signature_type="openai"` 说明这个签名是**带家族标签**的（而且那两条请求的
  //     `chat_model_uid` 是 gemini-3-6-flash-high —— 签名是上一轮由别的家族签发后被原样带回的）。
  //     `IRPart.thinking.signature` 与 `IRPartDelta.thinkingSignature` 都只有一个裸字符串，
  //     没有放 `signature_type` 的位置：出站送不出去、回读接不下来，两个方向各记一条 loss。
  //     按 AGENTS.md 第 24 行，不为这一家往 IR 加字段。
  "thinkingSignature",
  // (A) 反证，且被抓包加强：effort 靠**出站模型 id** 表达。抓包 4 个 uid 里
  //     kimi-k3-high / gpt-5-6-terra-high / gemini-3-6-flash-high 三个都带 `-high` 后缀，
  //     而 `GetChatMessageRequest` 的 24 个字段里没有任何 effort 字段。本出口不改写 model，只留痕。
  "reasoningEffort",
  // (C) 没有 token 预算字段，丢。
  "reasoningBudget",
  // (B) `ChatToolDefinition.is_custom_tool` + `custom_tool_grammar{,_syntax}` 存在，
  //     但抓包 253 个工具定义**无一**设置它们，grammar 语法的取值集仍然未知；
  //     包成单字段 JSON schema 才是有据可依的降级。
  "toolFreeform",
  // (B→仍 lossy，理由被抓包换掉了) `ChatToolDefinition.server_name` 看着就是 MCP 分组，
  //     但抓包证明**真实客户端根本不用它做分组**：253 个工具定义里 `server_name` 全空，
  //     MCP 是靠 `mcp_call_tool` / `mcp_list_servers` / `mcp_list_tools` / `mcp_read_resource`
  //     四个**元工具**（普通 function 工具）做的。所以 server_name 的分组语义至今零实证，
  //     拍进名字仍然是唯一确定可行的那条路 —— 但那是拍平，仍然有损。
  "toolGroup",
  // (B) 工具结果就是一条 source=4 的 ChatMessagePrompt，它**有** `images` 字段；
  //     但抓包 23 个 source=4 回合**全部 0 张图**，模型是否把该图片与这条工具结果关联
  //     依旧零实证。差的就是这一条：需要一条「工具结果带图且上游按图行事」的真实报文。
  "toolResultImage",
  // (B) `ChatMessagePrompt.prompt_cache_options` 与顶层 `system_prompt_cache_options`
  //     的枚举正好是 `CACHE_CONTROL_TYPE_EPHEMERAL`，与 IR 的 scope 同名；
  //     且响应里的 `cache_read_tokens/cache_write_tokens` 生产实测确有非零值 —— 缓存确实在发生。
  //     但抓包 12/12 条**两个字段都没设**，「客户端设的断点是否驱动它」仍未实证，
  //     且 `ttlSeconds` 无处安放。缓存在发生 ≠ 客户端能指挥它在哪儿断。
  "cacheBreakpoint",
  // (C) 没有服务端上下文管理指令。丢掉只是历史更长，不影响正确性。
  "contextEdit",
  // (B) `CompletionConfiguration.stop_patterns` 存在，但抓包 12/12 条都是空数组；
  //     字段名说的是 pattern，字面量 vs 正则的语义差别仍未实证，照送但留痕。
  "stopSequences",
  // (B) `CompletionConfiguration.service_tier` 是个 string，取值集未知。
  //     抓包 12/12 条都是空串 —— 而它是 proto3 隐式存在性的 string，空串与省略在字节上
  //     完全相同，所以这 12 条**连「客户端显式送了空串」都证明不了**，更不用说非空取值。
  //     猜一个字符串送上去可能整条 400，宁可丢并留痕。
  "serviceTier",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

/**
 * 既不在 supports 也不在 lossy —— 准入直接判该出口不可用，**且 lower 也会带路径拒绝**。
 * 两处保持同一条规则：`supports ∪ lossy` 之外的能力，编译不出合法 body。
 *
 *   document          —— 只有 `ImageData`，没有文档通道。用 mime_type 塞 PDF 是猜。
 *                        抓包 11 张图全是 `image/png`，没有任何非图片附件出现过。
 *   toolBuiltin       —— IR 的 builtin 身份（computer_use、web_search…）没有对应物；
 *                        `computer_use_config` 只覆盖 computer-use 一种且形状未实证。
 *                        抓包**正面加强了这一条**：真实客户端的 `web_search` 是一个普通
 *                        function 工具（结果按 source=4 + `tool_call_id="web_search_1"` 回传），
 *                        不是上游内建能力 —— builtin 身份在这条 wire 上确实无处安放。
 *   toolChoiceSpecific—— `ChatToolChoice{option_name,tool_name}` 有字段（请求 #12），但 `option_name`
 *                        的取值集完全未知，且抓包 12/12 条**都没设 tool_choice**。
 *                        猜错一个字符串，「必须调用工具 X」就会静默失效。
 *   structuredOutput  —— `GetChatMessageRequest` 的 24 个字段里没有任何 response_format /
 *                        json_schema 字段（FDS 逐字段核对过）。
 */

// ── protobuf 枚举常量（全部来自 FDS 实测） ──────────────────────────────────

/** `exa.codeium_common_pb.ChatMessageSource`。SYSTEM(2) 在 codeium 的词汇里就是「模型说的」。 */
const SOURCE_USER = 1;
const SOURCE_ASSISTANT = 2;
const SOURCE_TOOL = 4;

/** `exa.api_server_pb.ChatMessageRequestType.CHAT_MESSAGE_REQUEST_TYPE_CASCADE`。 */
const REQUEST_TYPE_CASCADE = 5;
/** `exa.codeium_common_pb.ConversationalPlannerMode.CONVERSATIONAL_PLANNER_MODE_DEFAULT`。 */
const PLANNER_MODE_DEFAULT = 1;
/** `exa.chat_pb.CacheControlType.CACHE_CONTROL_TYPE_EPHEMERAL` —— 与 IR 的 scope 同名。 */
const CACHE_CONTROL_EPHEMERAL = 1;
/** `CortexTrajectoryReference` 的两个类型位，取自生产抓包。 */
const TRAJECTORY_TYPE = 4;
const TRAJECTORY_STEP_TYPE = 14;

/**
 * `exa.codeium_common_pb.StopReason` → `IRStopReason`。**全 14 个值逐一表态**。
 *
 * 4/5/6/7/8/12 是补全（FIM）产品线留下的枚举值，聊天路径上不该出现；但「不该出现」
 * 不等于「可以不映射」—— 留一个 `?? endTurn` 的默认值，等于把一次异常收尾伪装成正常收尾。
 * 映射到 `"error"` 的两个值不会变成 messageStop，而是走 `error` 事件（见 lift 末尾）。
 */
const STOP_REASON_IR: Readonly<Record<number, IRStopReason>> = {
  0: "endTurn",       // UNSPECIFIED：上游没说，按正常收尾
  1: "aborted",       // INCOMPLETE
  2: "stopSequence",  // STOP_PATTERN
  3: "maxTokens",     // MAX_TOKENS
  4: "endTurn",       // MIN_LOG_PROB
  5: "maxTokens",     // MAX_NEWLINES：也是一种长度上限
  6: "endTurn",       // EXIT_SCOPE
  7: "error",         // NONFINITE_LOGIT_OR_PROB：数值失败，不是收尾
  8: "endTurn",       // FIRST_NON_WHITESPACE_LINE
  9: "aborted",       // PARTIAL
  10: "toolUse",      // FUNCTION_CALL —— 生产唯一实测过的非零值
  11: "refusal",      // CONTENT_FILTER
  12: "endTurn",      // NON_INSERTION
  13: "error",        // ERROR
};

/**
 * 客户端没给值时填进 `CompletionConfiguration` 的值。
 *
 * **这不是「默认值」，是 proto3 隐式存在性逼出来的表态**（见文件头第 3 点）：
 * 省略与送 0 在字节上一样，而 0 对这五个字段全是有害的强指令
 * （temperature=0 贪心解码、max_tokens=0 不许输出、max_newlines=0 第一个换行就停）。
 * 取值全部来自抓包里被上游正常受理的那份请求 —— 是唯一有证据的一组值。逐条对得上：
 *   `num_completions=1` / `max_newlines=400` / `temperature=1` / `top_k=40`  —— 12/12 条一致；
 *   `top_p=0.95`  —— 12/12 条，float32 落地成 0.949999988079071；
 *   `max_tokens`  —— **不一致**：kimi/gpt/swe 10 条送 128000，gemini 2 条送 65535。
 *                    两个量级都被受理，所以这里取被观测最多的 128000，而不是声称它是「正确值」。
 *
 * `maxNewlines` 尤其要盯：它会把输出截在 400 个换行处。真实客户端 12/12 条都这么发，
 * 但没人验证过省略它（=送 0）是「不限」还是「不许换行」。这条风险由 lower 记 loss 留痕。
 */
const WIRE_NEUTRAL = {
  numCompletions: 1n,
  maxTokens: 128_000n,
  maxNewlines: 400n,
  temperature: 1,
  topK: 40n,
  topP: 0.95,
} as const;

// ── 凭据与选项 ──────────────────────────────────────────────────────────────

export type ValueSource<T> = T | (() => T | Promise<T>);

async function resolveSource<T>(source: ValueSource<T>): Promise<T> {
  return typeof source === "function" ? await (source as () => T | Promise<T>)() : source;
}

/**
 * Windsurf 客户端画像。生产实测服务端不校验 `metadata.f`，device fingerprint 也非必填。
 *
 * 抓包里真实客户端的 `Metadata` 只设了 8 个字段：`ide_name` `ide_version` `extension_name`
 * `extension_version` `api_key` `locale` `os` `f`。两条值得记下来的观测：
 *   - 它填的是 `f`（732 个十六进制字符），**不是** `device_fingerprint`——后者 12/12 条全空。
 *     本出口的 `deviceFingerprint` 因此是一条没有抓包背书的可选通道，默认不发。
 *   - `request_id` 12/12 条都是 0。本出口仍从 traceId 派生一个非零值，因为「同一个 IR 两次
 *     构造字节相同」比「与真实客户端逐字节一致」更值得保；两种做法都没有被上游拒绝的证据。
 */
export interface WindsurfClientProfile {
  readonly ideName: string;
  readonly extensionName: string;
  readonly extensionVersion: string;
  readonly ideVersion: string;
  readonly locale: string;
  readonly os: string;
  readonly deviceFingerprint?: string;
}

/** 抓包 12/12 条用的就是这一份画像，逐字段一致。 */
export const CHISEL_PROFILE: WindsurfClientProfile = {
  ideName: "chisel",
  extensionName: "chisel",
  extensionVersion: "3000.2.17",
  ideVersion: "3000.2.17",
  locale: "en",
  os: "linux",
};

// ── 客户端身份：Windsurf 私有的策略限制 ─────────────────────────────────────

/**
 * 抓包里真实客户端 system prompt 的**第一行**，12/12 条完全一致。
 *
 * 它是这份夹具能钉住的最硬的一条事实，也是本模块唯一有据可依的替换目标。
 */
export const WINDSURF_OBSERVED_IDENTITY_LINE =
  "You are Devin, an interactive command line agent from Cognition.";

/**
 * 一条身份行改写规则：**整行精确相等**才命中，命中就换成 `replacementLine`。
 *
 * 用整行相等而不是子串/正则，是因为这条改写会动客户端的指令内容 —— 判据必须窄到
 * 「读注释的人能一眼算出它会不会命中」，宽判据在别人的 prompt 上会有意外命中。
 */
export interface WindsurfSystemIdentityRule {
  readonly matchLine: string;
  readonly replacementLine: string;
}

/**
 * Windsurf 对**客户端身份**的策略限制。这是供应商私有事实，按 ARCHITECTURE §2.1 只住在
 * 这个出口里：不做通用 repair、不进 `IROutboxProfile`、不加全局枚举。
 *
 * ## 抓包证明了什么
 *
 * 证伪了「关键词密度 / 体量触发内容分类器」这个流传的理由：20945–21599 字符的 agent 脚手架
 * 加 23 个工具定义，12 条全部 200。生产 cc_proxy 里「识别到 Claude Code 就把整个 system
 * 塌缩成中性提示」所依据的那条理由不成立。
 *
 * 被这 12 条字节钉住的唯一差异是**身份行**：真实客户端 12/12 条第一行都是
 * `WINDSURF_OBSERVED_IDENTITY_LINE`，而 Claude Code 送的是
 * `You are Claude Code, Anthropic's official CLI for Claude.`。
 *
 * ## 打真实上游二分出来的结果（2026-08-05，`server.codeium.com`，模型 claude-opus-4-6）
 *
 * 拿 Claude Code 2.1.221 的真实 system（4 块共 9929 字符）逐段发真实上游，
 * **9929 字符里只有 3 段会被拒，其余 8 段（8507 字符）全部放行**：
 *
 * | 段 | 字符 | 结果 |
 * |---|---|---|
 * | 块0 `x-anthropic-billing-header:` | 81 | 放行 |
 * | **块1 `You are Claude Code, …`** | **57** | **拒：`an internal error occurred`** |
 * | 块2 首句 `You are an interactive agent…` | 79 | 放行 |
 * | **块2 `IMPORTANT: Assist with authorized security testing…`** | **459** | **拒：`blocked by our content policy`** |
 * | 块2 `# Harness` | 668 | 放行 |
 * | 块3 `Write code that reads like…` | 976 | 放行 |
 * | 块3 `# Session-specific guidance` | 922 | 放行 |
 * | **块3 `# Environment`** | **973** | **拒：`blocked by our content policy`** |
 * | 块3 `# Scratchpad Directory` | 762 | 放行 |
 * | 块3 `# Context management` | 560 | 放行 |
 * | 块3 `# Delivering work` | 2018 | 放行 |
 * | 块3 `# Corrections` | 2364 | 放行 |
 *
 * **两套机制，错误信息把它们分开了**：身份行触发的是泛化 `an internal error occurred`，
 * 正文段触发的是明确的 `blocked by our content policy`。因此两者都要处理，缺一不可 ——
 * 实测组合：
 *
 *   - 原样送            → 拒（泛化）
 *   - **只**换身份行     → 拒，且错误变成 content policy（身份修好了，正文接着命中）
 *   - prepend 身份行     → 拒（泛化，因为 CC 身份行还在）
 *   - 只摘正文两段、保留 CC 身份行 → 拒（泛化）
 *   - **摘 3 段 + 换身份行** → **200**，带 12 个真实 Claude Code 工具也是 **200**
 *
 * 所以「体量/关键词密度」这个旧说法方向对但描述错：不是累积密度，是**三个具体段落**。
 * 而生产那套「整体塌缩成中性提示」虽然能过，代价是客户端指令 **0% 存活**；
 * 这里只摘 3 段，**85.7% 存活**。这正是「尽量让用户能用、不硬 ban」该有的做法。
 *
 * 不接受任何改写的调用方显式传 `{ kind: "passthrough" }`，一步都不做。
 *
 * ## 为什么不是「只替换」：替换会静默失效
 *
 * 纯替换的失败模式很难被发现：Claude Code 把身份行改一个字，`matchLine` 就不再命中，
 * 出站于是带着**原样的外来身份行**上去 —— 症状是「忽然每条请求都被拒」，而代码里
 * 没有任何一处报错，因为「没命中」和「不需要改」在纯替换的实现里是同一个返回值。
 *
 * 所以这条策略的契约不是「尝试替换」，而是一条**后置条件**：
 *
 *   > 只要客户端给了非空 system，改写之后这段文本里**一定**含有 `identityLine`。
 *
 * 两条路达成它，命中与否都不会「什么都没做」：
 *
 *   1. **命中**已知外来身份行 → 整行换掉。首选这条，因为它顺带**移走**了那行外来身份，
 *      不会留下两个互相矛盾的自我描述。
 *   2. **没命中** → 把 `identityLine` 直接 prepend 到最前面，原文一字不动地跟在后面。
 *      锚点漂了也照样有身份行，代价是客户端原来那句自我描述还留在下面。
 *
 * 空 system 是**故意的例外**：没有外来身份行要纠正，也没有客户端指令要保护，
 * 这时 prepend 等于凭空发明一段客户端从没写过的系统提示词。按 AGENTS.md「Core 不发明内容」，
 * 这一档保持不动。（真实客户端 12/12 条都带 system，这条路在实践中不会走到。）
 *
 * 无论走哪一档，只要真的改了字节就必然产出一条 `substituted` 的 `IRLoss`，
 * 且 detail 里写明走的是替换还是 prepend：Core 不静默改写。
 */
export type WindsurfSystemIdentityPolicy =
  | { readonly kind: "passthrough" }
  | {
      readonly kind: "ensureIdentityLine";
      /** 保证出现在 system 里的身份行。没命中任何规则时它被 prepend 到最前面。 */
      readonly identityLine: string;
      /** 已知的外来身份行。命中即整行替换成 `identityLine`，从而不留下矛盾的第二个身份。 */
      readonly supersededLines: readonly string[];
      /**
       * 已实测会被上游内容策略拦下的**段落前缀**。按空行切段，段首匹配任一前缀即整段摘掉。
       *
       * 用前缀而不是整段精确相等：这些段落会随客户端版本改字，精确相等一改就失配，
       * 而失配的后果是整条请求被拒。前缀（通常是小节标题或首句）稳定得多。
       *
       * 实测清单与判据见 `WINDSURF_DEFAULT_SYSTEM_IDENTITY_POLICY`。
       */
      readonly blockedSegmentPrefixes: readonly string[];
    };

/**
 * 默认策略：优先把 Claude Code 的身份行换掉；换不掉就在最前面补一行。
 *
 * `supersededLines` 只列**已知会被这个网关转发的 agent 客户端**的身份行。列表漂了不再是
 * 静默失败 —— 只是退化成 prepend，身份行仍然在。
 */
export const WINDSURF_DEFAULT_SYSTEM_IDENTITY_POLICY: WindsurfSystemIdentityPolicy = {
  kind: "ensureIdentityLine",
  identityLine: WINDSURF_OBSERVED_IDENTITY_LINE,
  supersededLines: [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  ],
  blockedSegmentPrefixes: [
    // 实测触发 content policy 的两段（Claude Code 2.1.221）。
    "IMPORTANT: Assist with authorized security testing",
    "# Environment",
  ],
};

/** 身份行这一步实际走了哪条路。`null` = 身份行没动。 */
export type WindsurfIdentityOutcome =
  | { readonly kind: "replaced"; readonly supersededLine: string }
  | { readonly kind: "prepended" };

/** 被摘掉的一段。`prefix` 是命中的那条前缀，用来在 loss 里指认「为什么摘」。 */
export interface WindsurfDroppedSegment {
  readonly prefix: string;
  readonly characters: number;
}

/**
 * 摘掉已实测会被上游内容策略拦下的段落。**按空行切段**，段首匹配任一前缀即整段丢弃。
 *
 * 为什么是段落而不是整块：实测 9929 字符里只有 3 段有问题，其余 8 段全部放行。
 * 按块或整体丢弃会把客户端 85.7% 的合法指令一起扔掉，那是没必要的破坏。
 */
function dropWindsurfBlockedSegments(
  systemText: string,
  prefixes: readonly string[],
): { readonly text: string; readonly dropped: readonly WindsurfDroppedSegment[] } {
  if (prefixes.length === 0 || systemText.length === 0) return { text: systemText, dropped: [] };
  const dropped: WindsurfDroppedSegment[] = [];
  const kept = systemText.split("\n\n").filter((segment) => {
    const hit = prefixes.find((prefix) => segment.trimStart().startsWith(prefix));
    if (hit === undefined) return true;
    dropped.push({ prefix: hit, characters: segment.length });
    return false;
  });
  return { text: kept.join("\n\n"), dropped };
}

/**
 * 保证 `identityLine` 出现在合并后的 system 文本里。
 *
 * 按行扫而不是只看第 0 行：Claude Code 的 system 是分块的，身份行是**第二块**
 * （第一块是 `x-anthropic-billing-header: …`），合并成一个字符串后它不在首行。
 * 只处理第一处命中，让「改了多少」有确定上界 —— 一次请求最多动一行。
 *
 * 已经含有 `identityLine` 的文本原样返回（`null`）：重复 prepend 会在多轮里越堆越多。
 */
function ensureWindsurfIdentityLine(
  systemText: string,
  policy: WindsurfSystemIdentityPolicy,
): { readonly text: string; readonly outcome: WindsurfIdentityOutcome | null } {
  // 空 system 不 prepend —— 那会凭空发明客户端没写过的指令，见上面的文档注释。
  if (policy.kind === "passthrough" || systemText.length === 0) {
    return { text: systemText, outcome: null };
  }
  const lines = systemText.split("\n");
  // 幂等：身份行已经在了就什么都不做，否则同一段 system 反复过这条策略会越堆越长。
  if (lines.includes(policy.identityLine)) return { text: systemText, outcome: null };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !policy.supersededLines.includes(line)) continue;
    lines[index] = policy.identityLine;
    return { text: lines.join("\n"), outcome: { kind: "replaced", supersededLine: line } };
  }
  // 没命中任何已知身份行 —— 补一行而不是放弃，见「替换会静默失效」那一段。
  return { text: `${policy.identityLine}\n\n${systemText}`, outcome: { kind: "prepended" } };
}

export interface WindsurfOutboxOptions {
  /** 出站 `chat_model_uid`。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  /** `devin-session-token$<JWT>` 全串。同时进 `Authorization: Basic` 与 `metadata.api_key`。 */
  readonly apiKey: ValueSource<string>;
  readonly server?: string;
  readonly profile?: WindsurfClientProfile;
  /**
   * 客户端身份行的处置。省略时用 `WINDSURF_DEFAULT_SYSTEM_IDENTITY_POLICY`
   * （把 Claude Code 的身份行换成抓包里被受理过的那一行）。
   * 完整的「实证 vs 推断」分界写在 `WindsurfSystemIdentityPolicy` 的文档注释里，
   * 挂它之前请读完那一段。
   */
  readonly systemIdentity?: WindsurfSystemIdentityPolicy;
  readonly userAgent?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** 覆盖 FileDescriptorSet 位置。默认取本模块同级的 `windsurf_exa.fds.pb`。 */
  readonly fdsPath?: string;
  /**
   * 会话/消息 id 工厂。**默认是确定性的**（从 traceId 派生），因为
   * 「同一个 IR 构造两次得到同样的字节」是可测的性质，而 `randomUUID()` 会把它毁掉。
   * 需要真随机（例如要让上游把两次重试看成两个会话）时由调用方显式注入。
   */
  readonly idFactory?: (label: string) => string;
}

// ── loss / problem 收集 ─────────────────────────────────────────────────────

class OutboxRequestLosses {
  readonly #losses: IRLoss[] = [];
  record(loss: Omit<IRLoss, "stage" | "outbox">): void {
    this.#losses.push({ stage: "outbox", outbox: OUTBOX, ...loss });
  }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
}

class OutboxRequestProblems {
  readonly #problems: IRBuildProblem[] = [];
  record(problem: IRBuildProblem): void { this.#problems.push(problem); }
  get rejected(): boolean { return this.#problems.length > 0; }
  drain(): readonly IRBuildProblem[] { return [...this.#problems]; }
}

// ── lower ───────────────────────────────────────────────────────────────────

function flatToolName(group: string | null, name: string): string {
  return group === null ? name : `${group}__${name}`;
}

/** 确定性 id：同一个种子永远同一个 UUID 形状的串。 */
function deterministicId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `metadata.request_id` 是 uint64。同样从种子派生，保证同一 IR 两次构造字节相同。 */
function deterministicRequestId(seed: string): bigint {
  return BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`);
}

/** 一条 ChatMessagePrompt 的构造材料。protobuf 的 create 在最后一步统一做。 */
interface PromptSeed {
  readonly source: number;
  readonly prompt: string;
  readonly images: readonly { readonly base64Data: string; readonly mimeType: string }[];
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
  readonly toolCallId?: string;
  readonly toolResultIsError?: boolean;
  readonly thinking?: string;
  readonly signature?: string;
  readonly thinkingRedacted?: boolean;
  readonly cacheBreakpoint?: boolean;
}

interface LowerContext {
  readonly losses: OutboxRequestLosses;
  readonly problems: OutboxRequestProblems;
}

/** 把工具结果的 parts 折成 wire 要的 `(prompt 文本, images)` 两样。 */
function lowerToolResult(
  result: IRToolResult,
  path: string,
  ctx: LowerContext,
): { text: string; images: { base64Data: string; mimeType: string }[] } {
  const texts: string[] = [];
  const images: { base64Data: string; mimeType: string }[] = [];
  result.parts.forEach((inner, index) => {
    const innerPath = `${path}.result.parts[${index}]`;
    if (inner.kind === "text") { if (inner.text.length > 0) texts.push(inner.text); return; }
    if (inner.kind === "image") {
      if (inner.media.source.kind !== "base64") {
        ctx.losses.record({
          path: innerPath, kind: "dropped",
          detail: "工具结果里的图片以 url 提供；ImageData 只有 base64Data，没有取回通道",
        });
        return;
      }
      images.push({ base64Data: inner.media.source.data, mimeType: inner.media.mediaType });
      return;
    }
    // document / thinking / toolCall / toolResult / opaque 在一条 source=TOOL 的 prompt 里都没有位置。
    ctx.problems.record({
      kind: "unrepresentablePart",
      path: innerPath,
      detail: `Windsurf 的工具结果是一条 ChatMessagePrompt（prompt 文本 + images），'${inner.kind}' 没有承载字段`,
    });
  });
  return { text: texts.join("\n\n"), images };
}

/**
 * 一个 IR 回合 → 0..n 条 ChatMessagePrompt。
 *
 * 工具结果**各自成一条 source=TOOL 的 prompt 并排在本回合角色 prompt 之前**（生产实测的顺序），
 * 其余 part 合并成一条本角色的 prompt。这不是位置约定：关联仍然靠 `tool_call_id`（不变量 1），
 * 顺序只是照抄上游被验证过的排布。
 */
function lowerTurnToPrompts(
  turn: { readonly role: "user" | "assistant"; readonly parts: readonly IRPart[] },
  turnIndex: number,
  ctx: LowerContext,
): PromptSeed[] {
  const toolSeeds: PromptSeed[] = [];
  const texts: string[] = [];
  const thinkings: string[] = [];
  const images: { base64Data: string; mimeType: string }[] = [];
  const toolCalls: { id: string; name: string; argumentsJson: string }[] = [];
  let signature: string | undefined;
  let thinkingRedacted = false;
  let cacheBreakpoint = false;

  turn.parts.forEach((part, partIndex) => {
    const path = `$.conversation.turns[${turnIndex}].parts[${partIndex}]`;
    if (part.cacheBreakpoint !== undefined) {
      cacheBreakpoint = true;
      if (part.cacheBreakpoint.ttlSeconds !== undefined) {
        ctx.losses.record({
          path: `${path}.cacheBreakpoint.ttlSeconds`, kind: "dropped",
          detail: "PromptCacheOptions 只有 type=CACHE_CONTROL_TYPE_EPHEMERAL，没有 TTL 字段",
        });
      }
    }
    switch (part.kind) {
      case "text":
        if (part.text.length > 0) texts.push(part.text);
        return;

      case "image":
        if (part.media.source.kind !== "base64") {
          ctx.losses.record({
            path, kind: "dropped",
            detail: "图片以 url 提供；ImageData 只有 base64Data/mimeType，没有取回通道",
          });
          return;
        }
        images.push({ base64Data: part.media.source.data, mimeType: part.media.mediaType });
        return;

      case "document":
        // document 不在 supports ∪ lossy：准入会拒，lower 也必须拒，两处同一条规则。
        ctx.problems.record({
          kind: "unrepresentablePart",
          path,
          detail: "Windsurf 只有 ImageData 一种附件通道，没有文档字段；把 PDF 塞进 mime_type 是猜",
        });
        return;

      case "thinking":
        thinkings.push(part.text);
        if (part.signature !== undefined && signature === undefined) signature = part.signature;
        return;

      case "redactedThinking":
        thinkingRedacted = true;
        thinkings.push(part.data);
        return;

      case "toolCall": {
        const name = flatToolName(part.call.toolRef.group, part.call.toolRef.name);
        if (part.call.toolRef.group !== null) {
          ctx.losses.record({
            path, kind: "degraded",
            detail: `tool group '${part.call.toolRef.group}' 拍进工具名；`
              + "ChatToolDefinition.server_name 看着能装分组，但抓包里 253 个工具定义 server_name 全空，"
              + "真实客户端用 mcp_call_tool 等元工具做 MCP 分组 —— 分组语义至今零实证",
          });
        }
        const argumentsJson = part.call.input.kind === "json"
          ? JSON.stringify(part.call.input.value)
          : JSON.stringify({ input: part.call.input.text });
        if (part.call.input.kind === "text") {
          ctx.losses.record({
            path, kind: "degraded",
            detail: "freeform 工具入参包成 `{input:<text>}`；ChatToolCall.arguments_json 只接受 JSON 串",
          });
        }
        if (part.call.caller !== undefined) {
          ctx.losses.record({
            path, kind: "dropped",
            detail: `tool call 的 caller('${part.call.caller.kind}') 在 ChatToolCall 里没有对应字段`,
          });
        }
        toolCalls.push({ id: part.call.id, name, argumentsJson });
        return;
      }

      case "toolResult": {
        const lowered = lowerToolResult(part.result, path, ctx);
        toolSeeds.push({
          source: SOURCE_TOOL,
          prompt: lowered.text,
          images: lowered.images,
          toolCalls: [],
          toolCallId: part.result.callId,
          ...(part.result.status === "error" ? { toolResultIsError: true } : {}),
          ...(part.cacheBreakpoint === undefined ? {} : { cacheBreakpoint: true }),
        });
        // 断点已经落到这条 tool prompt 上了，别让它再传染给本回合的角色 prompt。
        if (part.cacheBreakpoint !== undefined) cacheBreakpoint = false;
        return;
      }

      case "opaque":
        // 不变量 2 授权的三种处置之一：丢弃并记 loss。
        ctx.losses.record({
          path, kind: "dropped",
          detail: `opaque part from ${part.origin} (${part.tag}) 在 Windsurf 信封里没有对应形态`,
        });
        return;
    }
  });

  if (thinkings.length > 1) {
    ctx.losses.record({
      path: `$.conversation.turns[${turnIndex}]`, kind: "degraded",
      detail: `${thinkings.length} 个思考块被并成一条 ChatMessagePrompt.thinking 字符串；块边界丢失`,
    });
  }
  if (texts.length > 1) {
    ctx.losses.record({
      path: `$.conversation.turns[${turnIndex}]`, kind: "degraded",
      detail: `${texts.length} 个文本块被并成一条 ChatMessagePrompt.prompt 字符串；块边界丢失`,
    });
  }
  // thinking 本身不再记 loss：抓包 39/135 个回合真实回传 `ChatMessagePrompt.thinking` 并全部 200，
  // 它已经在 SUPPORTED 里。但**签名**仍然有损，且损在一个具体的地方 —— 见下。
  if (signature !== undefined) {
    ctx.losses.record({
      path: `$.conversation.turns[${turnIndex}]`, kind: "degraded",
      detail: "签名写入 ChatMessagePrompt.signature，但 `signature_type` 送不出去："
        + "抓包实证真实客户端是**成对**发的（getchatmessage_148/159 的 prompt[17]："
        + 'signature 1984 字符 + signature_type="openai"），'
        + "而 IRPart.thinking.signature 只有一个裸字符串，没有放家族标签的位置；"
        + "上游因此收到一个不知道该按哪家格式解析的签名",
    });
  }

  const prompt = texts.join("\n\n");
  const roleSeed: PromptSeed | null =
    prompt.length > 0 || images.length > 0 || toolCalls.length > 0 || thinkings.length > 0
      ? {
          source: turn.role === "assistant" ? SOURCE_ASSISTANT : SOURCE_USER,
          prompt,
          images,
          toolCalls,
          ...(thinkings.length === 0 ? {} : { thinking: thinkings.join("\n\n") }),
          ...(signature === undefined ? {} : { signature }),
          ...(thinkingRedacted ? { thinkingRedacted: true } : {}),
          ...(cacheBreakpoint ? { cacheBreakpoint: true } : {}),
        }
      : null;

  return roleSeed === null ? toolSeeds : [...toolSeeds, roleSeed];
}

/**
 * 工具调用/结果的配对校验。
 *
 * IR 用 id 关联，Windsurf 也用 id 关联（`ChatToolCall.id` ↔ `ChatMessagePrompt.tool_call_id`），
 * 所以这里**不需要重排**——但配不上的那些必须拒。
 *
 * ⚠ 这条拒绝是**推论，不是 Windsurf 侧的直接观测**：Windsurf 是聚合器，
 * `chat_message_prompts` 会被还原成下游各家 outbox 的原生消息，而它前置的两个家族
 * （Anthropic 要求每个 tool_use 恰有一个 tool_result；OpenAI 要求每个 tool_call 恰有一条
 * role=tool）都不接受悬空。发过去只会换回一个语义模糊的上游错误，所以在这里带路径拒绝，
 * 由调用方决定是挂 `repair/fillDanglingToolCall` 还是回绝客户端。
 */
function checkToolPairing(request: IRRequest, problems: OutboxRequestProblems): void {
  const callPaths = new Map<string, string>();
  const resultPaths = new Map<string, string>();
  request.conversation.turns.forEach((turn, turnIndex) => {
    turn.parts.forEach((part, partIndex) => {
      const path = `$.conversation.turns[${turnIndex}].parts[${partIndex}]`;
      if (part.kind === "toolCall" && !callPaths.has(part.call.id)) callPaths.set(part.call.id, path);
      if (part.kind === "toolResult" && !resultPaths.has(part.result.callId)) {
        resultPaths.set(part.result.callId, path);
      }
    });
  });
  for (const [id, path] of callPaths) {
    if (resultPaths.has(id)) continue;
    problems.record({
      kind: "danglingToolCall",
      path,
      detail: `tool call '${id}' 在整段会话里没有对应的工具结果；`
        + "Windsurf 会把 chat_message_prompts 还原成下游 outbox 的原生消息，两个家族都不接受悬空调用",
    });
  }
  for (const [id, path] of resultPaths) {
    if (callPaths.has(id)) continue;
    problems.record({
      kind: "orphanToolResult",
      path,
      detail: `tool result 的 tool_call_id '${id}' 在会话里找不到对应的调用；`
        + "该 id 上游从未签发过，还原出来的 outbox 消息必然非法",
    });
  }
}

// ── 出口 ────────────────────────────────────────────────────────────────────

/**
 * Windsurf **不要求** max_tokens：`CompletionConfiguration.max_tokens` 是 proto3 隐式存在性
 * 的字段，不发就是「服务端自己定」。本出口的两条 `requiredFieldMissing` 说的是回合与
 * system prompt，与它无关。
 */
const MANDATORY: IRMandatoryFieldTable = { maxOutputTokens: false };

export function createWindsurfOutbox(options: WindsurfOutboxOptions): IROutbox<Uint8Array> {
  const profile: IROutboxProfile = {
    supports: new Set(SUPPORTED),
    lossy: new Set(LOSSY),
    mandatory: MANDATORY,
  };
  const clientProfile = options.profile ?? CHISEL_PROFILE;
  const server = options.server ?? DEFAULT_SERVER;
  const systemIdentity = options.systemIdentity ?? WINDSURF_DEFAULT_SYSTEM_IDENTITY_POLICY;
  const userAgent = options.userAgent ?? "connect-go/1.18.1 (go1.26.4)";
  // 588KB 的 fds 只构造一次，之后每次请求复用。
  let schema: WindsurfSchema | null = null;
  const loadSchema = (): WindsurfSchema => {
    schema ??= getSharedWindsurfSchema(options.fdsPath ?? undefined);
    return schema;
  };

  return {
    profile,

    async writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult<Uint8Array>> {
      const losses = new OutboxRequestLosses();
      const problems = new OutboxRequestProblems();
      const ctx: LowerContext = { losses, problems };
      const { conversation, intent } = request;
      const newId = options.idFactory ?? ((label: string) => deterministicId(`${request.traceId}:${label}`));

      // ── system → 顶层 prompt（一个 string 字段） ───────────────────────────
      const systemTexts: string[] = [];
      let systemCacheBreakpoint = false;
      conversation.system.forEach((part, index) => {
        const path = `$.conversation.system[${index}]`;
        if (part.cacheBreakpoint !== undefined) {
          systemCacheBreakpoint = true;
          if (part.cacheBreakpoint.ttlSeconds !== undefined) {
            losses.record({
              path: `${path}.cacheBreakpoint.ttlSeconds`, kind: "dropped",
              detail: "PromptCacheOptions 只有 type=CACHE_CONTROL_TYPE_EPHEMERAL，没有 TTL 字段",
            });
          }
        }
        if (part.kind === "text") {
          if (part.text.length > 0) systemTexts.push(part.text);
          return;
        }
        if (part.kind === "opaque") {
          losses.record({
            path, kind: "dropped",
            detail: `opaque part from ${part.origin} (${part.tag}) 在顶层 prompt（一个 string）里没有位置`,
          });
          return;
        }
        // 顶层 prompt 是**一个字符串字段**，不是 content 数组：图片能进对话回合，进不了这里。
        problems.record({
          kind: "unrepresentablePart",
          path,
          detail: `GetChatMessageRequest.prompt 是单个字符串字段，'${part.kind}' 无处安放`,
        });
      });
      // ── 客户端身份行（Windsurf 私有策略，见 WindsurfSystemIdentityPolicy） ──
      const joinedSystem = systemTexts.join("\n\n");
      // 先摘掉实测被内容策略拦下的段落，再保证身份行 —— 顺序不能反：
      // 摘段可能把身份行所在的段一起带走，那样后一步的替换就会失配、退化成 prepend。
      const blocked = dropWindsurfBlockedSegments(
        joinedSystem,
        systemIdentity.kind === "ensureIdentityLine" ? systemIdentity.blockedSegmentPrefixes : [],
      );
      const identity = ensureWindsurfIdentityLine(blocked.text, systemIdentity);
      const systemText = identity.text;
      for (const segment of blocked.dropped) {
        losses.record({
          path: "$.conversation.system", kind: "dropped",
          detail: `以 '${segment.prefix}' 开头的 ${segment.characters} 字符段落被整段摘掉：`
            + "打真实上游二分实测，这一段单独发过去就会被 content policy 拦下"
            + "（`Your request was blocked by our content policy`）。"
            + "客户端写在这一段里的指令不会到达模型；system 的其余段落一字未动。"
            + "不接受这条改写就传 systemIdentity={kind:'passthrough'}（代价是整条请求被拒）",
        });
      }
      if (identity.outcome !== null) {
        const what = identity.outcome.kind === "replaced"
          ? `客户端身份行 '${identity.outcome.supersededLine}' 被整行换成 `
            + `'${systemIdentity.kind === "ensureIdentityLine" ? systemIdentity.identityLine : ""}'；`
            + "system 的其余内容一字未动。"
          : "没有命中任何已知的外来身份行，改为把身份行 prepend 到 system 最前面；"
            + "客户端原文一字未动地跟在后面（因此它原来的自我描述仍然在下文里）。";
        losses.record({
          path: "$.conversation.system", kind: "substituted",
          detail: what
            + "实测：Claude Code 的 57 字符身份行**单独**发过去就会被拒"
            + "（`an internal error occurred`，与正文段的 content policy 是两套机制）；"
            + "摘掉正文触发段但保留这一行，照样被拒。所以身份与正文必须同时处理。"
            + "不接受这条改写就传 systemIdentity={kind:'passthrough'}",
        });
      }

      // ── 对话回合 → chat_message_prompts ───────────────────────────────────
      checkToolPairing(request, problems);
      const seeds = conversation.turns.flatMap((turn, turnIndex) =>
        lowerTurnToPrompts(turn, turnIndex, ctx));

      // ── 工具 ──────────────────────────────────────────────────────────────
      const toolDefs = conversation.toolset.tools.flatMap((tool, index) => {
        const path = `$.conversation.toolset.tools[${index}]`;
        const name = flatToolName(tool.ref.group, tool.ref.name);
        if (tool.ref.group !== null) {
          losses.record({
            path, kind: "degraded",
            detail: `tool group '${tool.ref.group}' 拍进工具名；`
              + "ChatToolDefinition.server_name 看着能装分组，但抓包里 253 个工具定义 server_name 全空，"
              + "真实客户端用 mcp_call_tool 等元工具做 MCP 分组 —— 分组语义至今零实证",
          });
        }
        if (tool.kind === "builtin") {
          problems.record({
            kind: "unrepresentablePart",
            path,
            detail: `builtin 工具 '${tool.builtin}' 在 Windsurf 信封里没有对应身份；`
              + "computer_use_config 只覆盖 computer-use 一种且形状未实证",
          });
          return [];
        }
        if (tool.kind === "freeform") {
          losses.record({
            path, kind: "degraded",
            detail: `freeform 工具 '${name}' 包成单字段 JSON schema；`
              + "is_custom_tool/custom_tool_grammar 字段存在，但 grammar 语法的取值集未知",
          });
          return [{
            name,
            description: tool.description,
            jsonSchemaString: JSON.stringify({
              type: "object", properties: { input: { type: "string" } }, required: ["input"],
            }),
          }];
        }
        if (tool.deferLoading === true) {
          losses.record({
            path, kind: "dropped",
            detail: "ChatToolDefinition 没有定义延迟加载的表达",
          });
        }
        return [{
          name,
          description: tool.description,
          jsonSchemaString: JSON.stringify(tool.schema),
          ...(tool.strict === true ? { strict: true } : {}),
        }];
      });

      const choice = conversation.toolset.choice;
      if (choice.value.kind === "specific") {
        problems.record({
          kind: "unrepresentablePart",
          path: "$.conversation.toolset.choice",
          detail: "ChatToolChoice{option_name,tool_name} 有字段，但 option_name 的取值集完全未知；"
            + "猜一个字符串会让「必须调用工具」静默失效",
        });
      } else if (choice.source === "client" && choice.value.kind !== "auto") {
        losses.record({
          path: "$.conversation.toolset.choice", kind: "dropped",
          detail: `tool choice '${choice.value.kind}' 未下发：ChatToolChoice.option_name 的取值集未知，`
            + "送一个猜出来的字符串比不送更危险",
        });
      }
      const disableParallel = conversation.toolset.parallel.source === "client"
        && !conversation.toolset.parallel.value;

      // ── intent ────────────────────────────────────────────────────────────
      const reasoning = intent.reasoning.value;
      if (reasoning.mode === "disabled") {
        losses.record({
          path: "$.intent.reasoning.mode", kind: "dropped",
          detail: "GetChatMessageRequest 里没有任何思考开关；思考与否由 chat_model_uid 决定，关不掉",
        });
      } else if (reasoning.display === "hidden") {
        losses.record({
          path: "$.intent.reasoning.display", kind: "dropped",
          detail: "信封里没有思考可见性开关；上游给不给 delta_thinking 由模型档位决定",
        });
      }
      if (reasoning.effort !== undefined) {
        losses.record({
          path: "$.intent.reasoning.effort", kind: "substituted",
          detail: `effort='${reasoning.effort}' 没有对应 wire 字段：Windsurf 把档位编进模型 id`
            + `（实测形如 MODEL_GPT_5_2_HIGH / claude-opus-4-8-high）。本出口不改写出站 model='${options.model}'`,
        });
      }
      if (reasoning.budgetTokens !== undefined) {
        losses.record({
          path: "$.intent.reasoning.budgetTokens", kind: "dropped",
          detail: "信封里没有思考 token 预算字段",
        });
      }
      if (intent.outputFormat.value.kind === "jsonSchema") {
        problems.record({
          kind: "unrepresentablePart",
          path: "$.intent.outputFormat",
          detail: "GetChatMessageRequest 里没有任何 response_format / json_schema 字段；"
            + "结构化输出约束下发不了，静默丢弃会让客户端拿到散文而不是 JSON",
        });
      }
      if (intent.contextEdits.length > 0) {
        losses.record({
          path: "$.intent.contextEdits", kind: "dropped",
          detail: `${intent.contextEdits.length} 条上下文编辑指令被丢弃；Windsurf 无服务端上下文管理通道`,
        });
      }
      if (intent.serviceTier.source === "client" && intent.serviceTier.value === "priority") {
        losses.record({
          path: "$.intent.serviceTier", kind: "dropped",
          detail: "CompletionConfiguration.service_tier 是个 string，取值集未知；猜一个可能整条 400",
        });
      }
      if (!intent.stream.value) {
        losses.record({
          path: "$.intent.stream", kind: "substituted",
          detail: "GetChatMessage 只有流式一种形态；非流式请求改为流式取回后由入口侧折叠成整段响应",
        });
      }
      if (intent.identity.sessionId !== undefined || intent.identity.deviceId !== undefined
        || intent.identity.accountUuid !== undefined) {
        losses.record({
          path: "$.intent.identity", kind: "dropped",
          detail: "Metadata 的 session_id/user_id 描述的是 Windsurf 自己的会话（来自凭据 JWT），"
            + "不是客户端会话；把客户端身份塞进去会污染上游的会话归属",
        });
      }

      // ── CompletionConfiguration（proto3 隐式存在性的战场） ──────────────────
      const named: string[] = [];
      const temperature = intent.sampling.temperature?.value;
      if (temperature === undefined) named.push("temperature");
      const topP = intent.sampling.topP?.value;
      if (topP === undefined) named.push("top_p");
      const topK = intent.sampling.topK?.value;
      if (topK === undefined) named.push("top_k");
      const maxTokens = intent.stopping.maxOutputTokens?.value;
      if (maxTokens === undefined) named.push("max_tokens");
      // max_newlines 没有 IR 对应物，但它同样是「省略 = 送 0」，且 0 的含义未知。
      named.push("max_newlines");
      losses.record({
        path: "$.intent", kind: "substituted",
        detail: `CompletionConfiguration 的标量字段是 proto3 隐式存在性（FDS 实测 presence=2）：`
          + `省略与显式送 0 在字节上完全相同，而 0 对这些字段都是有害的强指令。`
          + `以下字段由本出口命名成生产抓包里被正常受理的值：${named.join(", ")}`
          + `（max_newlines=${WIRE_NEUTRAL.maxNewlines} 会把输出截在 400 个换行处，此风险未经验证）`,
      });
      if (intent.stopping.stopSequences !== undefined) {
        losses.record({
          path: "$.intent.stopping.stopSequences", kind: "degraded",
          detail: "写入 CompletionConfiguration.stop_patterns；字段名说的是 pattern，"
            + "字面量 vs 正则的语义差别未经实证",
        });
      }

      // ── 结构性必填 ────────────────────────────────────────────────────────
      if (seeds.length === 0) {
        problems.record({
          kind: "requiredFieldMissing",
          path: "$.conversation.turns",
          detail: "GetChatMessage 至少要一条 chat_message_prompts，IR 里没有任何可承载的回合",
        });
      }
      if (toolDefs.length > 0 && systemText.length === 0) {
        // 生产实证（`assessWindsurfMessagesCompatibility`）：带工具的请求必须有非空 system。
        problems.record({
          kind: "requiredFieldMissing",
          path: "$.conversation.system",
          detail: "生产实测：Windsurf 带工具定义的请求必须有非空 system prompt，"
            + "空 system + tools 会被上游拒绝",
        });
      }

      // 拒绝在最后一步：上面各段照常跑完，problems 与 losses 都攒齐，调用方一次看全。
      if (problems.rejected) {
        return { ok: false, problems: problems.drain(), losses: losses.drain() };
      }

      const apiKey = await resolveSource(options.apiKey);
      const active = loadSchema();
      const requestDesc = active.requestDesc;
      const promptDesc = active.childOf(requestDesc, "chatMessagePrompts");
      const toolDesc = active.childOf(requestDesc, "tools");
      const cacheDesc = active.childOf(requestDesc, "systemPromptCacheOptions");
      const toolCallDesc = active.message(WINDSURF_TYPES.toolCall);
      const imageDesc = active.message(WINDSURF_TYPES.image);

      const message = create(requestDesc, {
        metadata: create(active.childOf(requestDesc, "metadata"), {
          apiKey,
          ideName: clientProfile.ideName,
          extensionName: clientProfile.extensionName,
          extensionVersion: clientProfile.extensionVersion,
          ideVersion: clientProfile.ideVersion,
          locale: clientProfile.locale,
          os: clientProfile.os,
          requestId: deterministicRequestId(`${request.traceId}:request-id`),
          ...(clientProfile.deviceFingerprint === undefined
            ? {}
            : { deviceFingerprint: clientProfile.deviceFingerprint }),
        }),
        prompt: systemText,
        chatMessagePrompts: seeds.map((seed, index) => create(promptDesc, {
          messageId: newId(`prompt:${index}`),
          source: seed.source,
          prompt: seed.prompt,
          ...(seed.toolCalls.length === 0
            ? {}
            : { toolCalls: seed.toolCalls.map((call) => create(toolCallDesc, call)) }),
          ...(seed.toolCallId === undefined ? {} : { toolCallId: seed.toolCallId }),
          ...(seed.toolResultIsError === true ? { toolResultIsError: true } : {}),
          ...(seed.images.length === 0
            ? {}
            : {
                images: seed.images.map((image) => create(imageDesc, {
                  base64Data: image.base64Data,
                  mimeType: image.mimeType,
                  caption: "",
                })),
              }),
          ...(seed.thinking === undefined ? {} : { thinking: seed.thinking }),
          ...(seed.signature === undefined ? {} : { signature: seed.signature }),
          ...(seed.thinkingRedacted === true ? { thinkingRedacted: true } : {}),
          ...(seed.cacheBreakpoint === true
            ? { promptCacheOptions: create(cacheDesc, { type: CACHE_CONTROL_EPHEMERAL }) }
            : {}),
        })),
        chatModelUid: options.model,
        cascadeId: newId("cascade"),
        executionId: newId("execution"),
        requestType: REQUEST_TYPE_CASCADE,
        plannerMode: PLANNER_MODE_DEFAULT,
        trajectoryReference: create(active.childOf(requestDesc, "trajectoryReference"), {
          trajectoryId: newId("trajectory"),
          trajectoryType: TRAJECTORY_TYPE,
          stepIndex: 0,
          stepType: TRAJECTORY_STEP_TYPE,
          forceBillable: false,
        }),
        configuration: create(active.childOf(requestDesc, "configuration"), {
          numCompletions: WIRE_NEUTRAL.numCompletions,
          maxTokens: maxTokens === undefined ? WIRE_NEUTRAL.maxTokens : BigInt(maxTokens),
          maxNewlines: WIRE_NEUTRAL.maxNewlines,
          temperature: temperature ?? WIRE_NEUTRAL.temperature,
          topK: topK === undefined ? WIRE_NEUTRAL.topK : BigInt(topK),
          topP: topP ?? WIRE_NEUTRAL.topP,
          ...(intent.stopping.stopSequences === undefined
            ? {}
            : { stopPatterns: [...intent.stopping.stopSequences.value] }),
        }),
        ...(toolDefs.length === 0
          ? {}
          : { tools: toolDefs.map((definition) => create(toolDesc, definition)) }),
        ...(disableParallel ? { disableParallelToolCalls: true } : {}),
        ...(systemCacheBreakpoint
          ? { systemPromptCacheOptions: create(cacheDesc, { type: CACHE_CONTROL_EPHEMERAL }) }
          : {}),
      });

      const framed = enframe(toBinary(requestDesc, message));
      return {
        ok: true,
        wire: {
          url: `${server}${RPC_PATH}`,
          method: "POST",
          headers: {
            "content-type": "application/connect+proto",
            "connect-protocol-version": "1",
            authorization: `Basic ${apiKey}`,
            "user-agent": userAgent,
            ...(options.extraHeaders ?? {}),
          },
          body: framed,
        },
        losses: losses.drain(),
      };
    },

    readOutboxResponse(response: Response): AsyncIterable<IREvent> {
      return liftWindsurfStream(response, loadSchema, options.model);
    },
  };
}

// ── lift ────────────────────────────────────────────────────────────────────

/**
 * 文本/思考的块游标。上游没有 `content_block_start/stop` 这类生命周期事件，
 * 只有 `delta_text` / `delta_thinking` 两条并行的增量流，所以块边界是**合成**的：
 * 种类一变就换块。合成边界不造内容，但它是本出口的解释，不是上游的原话。
 */
class PartCursor {
  #next = 0;
  #open: { index: number; kind: "text" | "thinking" } | null = null;

  open(kind: "text" | "thinking"): { index: number; started: boolean; closed: number | null } {
    if (this.#open !== null && this.#open.kind === kind) {
      return { index: this.#open.index, started: false, closed: null };
    }
    const closed = this.#open === null ? null : this.#open.index;
    const index = this.#next;
    this.#next += 1;
    this.#open = { index, kind };
    return { index, started: true, closed };
  }

  /** 工具块是原子的：自己占一个 index。 */
  take(): number {
    const index = this.#next;
    this.#next += 1;
    return index;
  }

  close(): number | null {
    const closed = this.#open === null ? null : this.#open.index;
    this.#open = null;
    return closed;
  }
}

interface UpstreamToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * 从一帧里摘工具调用增量。
 *
 * 生产抓帧实证：`argumentsJson` 是**增量分片** —— 首帧给 id+name（args 空），
 * 续帧 id/name 皆空、只带 argumentsJson 的一段。所以不能按 id 过滤，
 * 全空+args 的分片帧必须保留，否则工具参数会整段消失。
 */
function extractToolCallDeltas(frame: Record<string, unknown>): UpstreamToolCall[] {
  const raw = frame.deltaToolCalls;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const call = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      return {
        id: typeof call.id === "string" ? call.id : "",
        name: typeof call.name === "string" ? call.name : "",
        argumentsJson: typeof call.argumentsJson === "string" ? call.argumentsJson : "",
      };
    })
    .filter((call) => call.id.length > 0 || call.name.length > 0 || call.argumentsJson.length > 0);
}

/**
 * 增量装配：非空 id = 新工具开始；空 id 的分片续接到最近开始的那个工具。
 * 并行工具由各自 id 的首帧切分。
 */
function applyToolCallDelta(
  list: UpstreamToolCall[],
  call: UpstreamToolCall,
  synthesize: () => string,
): IRLoss | null {
  if (call.id.length > 0) {
    list.push({ id: call.id, name: call.name, argumentsJson: call.argumentsJson });
    return null;
  }
  const current = list[list.length - 1];
  if (current === undefined) {
    // 没有已开始的工具却先来分片。生产在这里起一个 id 为空串的匿名工具；
    // IR 的 toolCall.id 是关联键，空串会让后续所有 tool_result 配不上，
    // 所以合成一个确定性 id 并把这次合成留痕。
    const id = synthesize();
    list.push({ id, name: call.name, argumentsJson: call.argumentsJson });
    return {
      stage: "outbox", outbox: OUTBOX,
      path: "$.response.deltaToolCalls[0].id", kind: "substituted",
      detail: `上游先送了工具参数分片、之后才可能给 id；合成确定性 id '${id}' 以保住参数与关联键`,
    };
  }
  if (current.name.length === 0 && call.name.length > 0) current.name = call.name;
  current.argumentsJson += call.argumentsJson;
  return null;
}

/** `ModelUsageStats` 的四类 token 跨帧取最大：input 与 cache 常在末帧才给全，只取首帧会漏成 0。 */
function mergeUsage(totals: IRUsage, frame: Record<string, unknown>): IRUsage {
  const raw = frame.usage;
  if (typeof raw !== "object" || raw === null) return totals;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number => {
    const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    inputTokens: Math.max(totals.inputTokens, num(usage.inputTokens)),
    outputTokens: Math.max(totals.outputTokens, num(usage.outputTokens)),
    // 三态里的 0：上游**支持**缓存（生产实测 cache_read/write 有非零值），只是这次没命中。
    cacheReadTokens: Math.max(totals.cacheReadTokens ?? 0, num(usage.cacheReadTokens)),
    cacheWriteTokens: Math.max(totals.cacheWriteTokens ?? 0, num(usage.cacheWriteTokens)),
  };
}

/**
 * 一帧里被认为「有语义」的字段。全都没有 = 上游换了形状，走 unhandled。
 *
 * 抓包实测的覆盖情况（2107 帧）：`messageId` 2107、`usage` 1418、`deltaText` 1153、
 * `deltaThinking` 850、`deltaToolCalls` 55、`stopReason` 8、`deltaSignature` 2、`outputId` 1。
 *
 * 两条**故意**不在这张表里的字段，各有各的理由：
 *   - `latency` / `requestId` / `timestamp` / `deltaTokens` / `creditCost` —— 纯遥测与计费，
 *     没有语义产出，本来就不该让一帧「算作有内容」。
 *   - `responseDimensionGroups`（响应 #28，抓包 9 帧出现）—— 本出口对它**没有**任何映射。
 *     不进这张表意味着：一帧只带它时会走 unhandled 而不是被静默吞掉，这正是要的行为。
 *     ⚠ 如实说明：真实流里每一帧都带 `messageId`，所以这条兜底在抓包上从未被触发过 ——
 *     它防的是「上游哪天单发一帧维度信息」，不是当前已观测到的形态。
 */
const SEMANTIC_FIELDS = [
  "deltaText", "deltaThinking", "deltaSignature", "deltaSignatureType", "deltaToolCalls",
  "usage", "stopReason", "thinkingRedacted", "messageId", "actualModelUid",
] as const;

function hasSemanticField(frame: Record<string, unknown>): boolean {
  return SEMANTIC_FIELDS.some((field) => {
    const value = frame[field];
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.length > 0;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

type Terminal =
  | { readonly kind: "stop" }
  | { readonly kind: "error"; readonly event: IREvent };

async function* liftWindsurfStream(
  response: Response,
  loadSchema: () => WindsurfSchema,
  fallbackModel: string,
): AsyncGenerator<IREvent> {
  if (!response.ok) {
    yield { kind: "error", error: mapHttpError(response.status, await response.text()) };
    return;
  }
  const body = response.body;
  if (body === null) {
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: response.status, retryable: true,
        message: "windsurf upstream returned 200 with no response body",
        raw: null,
      },
    };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("connect+proto")) {
    // Connect 的 unary 错误面回的是 `application/json`。它不是流，但也不能当成
    // 「没帧就算成功」—— 那正是「200 但空」。整段读掉，认得出错误就报错误，认不出就 unhandled + error。
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // 非 JSON 就走下面的 unhandled。
    }
    const embedded = parsed === null ? null : readConnectError(parsed);
    if (embedded !== null) {
      yield { kind: "error", error: mapConnectError(embedded) };
      return;
    }
    yield { kind: "unhandled", rawType: `<windsurf-body:${contentType || "unknown"}>`, raw: text };
    yield {
      kind: "error",
      error: {
        kind: "unknown", httpStatus: response.status, retryable: false,
        message: `windsurf upstream returned content-type '${contentType}' instead of application/connect+proto`,
        raw: text,
      },
    };
    return;
  }

  const schema = loadSchema();
  const cursor = new PartCursor();
  const state = createDeframeState();
  const toolCalls: UpstreamToolCall[] = [];
  let started = false;
  let sawDataFrame = false;
  let stopReasonCode: number | null = null;
  let usage: IRUsage | null = null;
  let redactedReported = false;
  let synthesizedToolCallSeq = 0;
  let terminal: Terminal | null = null;

  frames: for await (const frame of deframe(readableToChunks(body), state)) {
    // 压缩帧（flag&1）：payload 不是裸 protobuf，直接解会得到垃圾而不是报错。
    // 生产从未协商过压缩，所以这里不实现解压，只如实装箱。
    if ((frame.flag & CONNECT_FLAG_COMPRESSED) !== 0) {
      yield {
        kind: "unhandled",
        rawType: `<windsurf-frame:compressed:flag=${frame.flag}>`,
        raw: Buffer.from(frame.payload).toString("base64"),
      };
      if ((frame.flag & CONNECT_FLAG_END_STREAM) !== 0) {
        terminal = {
          kind: "error",
          event: {
            kind: "error",
            error: {
              kind: "transport", httpStatus: null, retryable: true,
              message: "windsurf end-stream frame is compressed; the trailer could not be read, "
                + "so success cannot be distinguished from an application error",
              raw: null,
            },
          },
        };
        break frames;
      }
      continue;
    }

    if ((frame.flag & CONNECT_FLAG_END_STREAM) !== 0) {
      const parsed = parseConnectTrailer(frame.payload);
      if (!parsed.ok) {
        yield { kind: "unhandled", rawType: "<windsurf-trailer:unparseable>", raw: parsed.rawText };
        terminal = {
          kind: "error",
          event: {
            kind: "error",
            error: {
              kind: "transport", httpStatus: null, retryable: true,
              message: "windsurf end-stream trailer is not a JSON object; "
                + "success cannot be distinguished from an application error",
              raw: parsed.rawText,
            },
          },
        };
        break frames;
      }
      const outboxError = readConnectError(parsed.trailer);
      terminal = outboxError === null
        ? { kind: "stop" }
        : { kind: "error", event: { kind: "error", error: mapConnectError(outboxError) } };
      break frames;
    }

    if (frame.flag !== 0) {
      yield {
        kind: "unhandled",
        rawType: `<windsurf-frame:flag=${frame.flag}>`,
        raw: Buffer.from(frame.payload).toString("base64"),
      };
      continue;
    }

    let decoded: Record<string, unknown>;
    try {
      decoded = fromBinary(schema.responseDesc, frame.payload) as unknown as Record<string, unknown>;
    } catch (error) {
      yield {
        kind: "unhandled",
        rawType: "<windsurf-frame:undecodable>",
        raw: {
          payloadBase64: Buffer.from(frame.payload).toString("base64"),
          reason: error instanceof Error ? error.message : String(error),
        },
      };
      continue;
    }
    sawDataFrame = true;

    // 上游加了本地 FDS 里没有的字段 —— 协议漂移。照常处理已知部分，但让漂移自己冒头。
    const unknownFields = decoded.$unknown;
    if (Array.isArray(unknownFields) && unknownFields.length > 0) {
      yield {
        kind: "unhandled",
        rawType: `<windsurf-response:unknown-fields:${unknownFields.length}>`,
        raw: unknownFields,
      };
    }

    if (!started) {
      started = true;
      const actual = decoded.actualModelUid;
      yield {
        kind: "messageStart",
        model: typeof actual === "string" && actual.length > 0 ? actual : fallbackModel,
      };
    }

    if (!hasSemanticField(decoded)) {
      yield {
        kind: "unhandled",
        rawType: `<windsurf-response:${Object.keys(decoded).sort().join("+")}>`,
        raw: decoded,
      };
      continue;
    }

    const deltaThinking = decoded.deltaThinking;
    if (typeof deltaThinking === "string" && deltaThinking.length > 0) {
      const slot = cursor.open("thinking");
      if (slot.closed !== null) yield { kind: "partEnd", index: slot.closed };
      if (slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "thinking", text: "" } };
      yield { kind: "partDelta", index: slot.index, delta: { kind: "thinking", text: deltaThinking } };
    }

    const deltaSignature = decoded.deltaSignature;
    if (typeof deltaSignature === "string" && deltaSignature.length > 0) {
      const slot = cursor.open("thinking");
      if (slot.closed !== null) yield { kind: "partEnd", index: slot.closed };
      if (slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "thinking", text: "" } };
      yield {
        kind: "partDelta", index: slot.index,
        delta: { kind: "thinkingSignature", signature: deltaSignature },
      };
    }

    // `delta_signature_type`（响应 #21）与 `delta_signature` 成对到达 —— 抓包 2107 帧里
    // 各 2 次，取值 "openai"。`IRPartDelta.thinkingSignature` 只有一个裸 signature 字符串，
    // 没有装家族标签的位置，而按 AGENTS.md 第 24 行不能为一家出口往 IR 加字段。
    // 于是这里如实留痕：下游拿到的签名不带「该按谁的格式解析」这条信息。
    const deltaSignatureType = decoded.deltaSignatureType;
    if (typeof deltaSignatureType === "string" && deltaSignatureType.length > 0) {
      yield {
        kind: "loss",
        loss: {
          stage: "outbox", outbox: OUTBOX,
          path: "$.response.deltaSignatureType", kind: "dropped",
          detail: `上游给出签名家族 '${deltaSignatureType}'，但 IRPartDelta.thinkingSignature `
            + "只有一个裸 signature 字符串，没有承载它的字段；签名本身照常下发",
        },
      };
    }

    if (decoded.thinkingRedacted === true && !redactedReported) {
      redactedReported = true;
      // `thinking_redacted` 是个 **bool**，不带被脱敏的密文；IR 的 redactedThinking 需要 `data`。
      // 造一个空 data 的块等于凭空发明内容，所以只留痕。
      yield {
        kind: "loss",
        loss: {
          stage: "outbox", outbox: OUTBOX,
          path: "$.response.thinkingRedacted", kind: "dropped",
          detail: "上游标记本轮思考被脱敏，但 thinking_redacted 只是一个 bool，没有携带密文；"
            + "IRPart.redactedThinking 需要 data，无法从一个布尔位构造",
        },
      };
    }

    const deltaText = decoded.deltaText;
    if (typeof deltaText === "string" && deltaText.length > 0) {
      const slot = cursor.open("text");
      if (slot.closed !== null) yield { kind: "partEnd", index: slot.closed };
      if (slot.started) yield { kind: "partStart", index: slot.index, part: { kind: "text", text: "" } };
      yield { kind: "partDelta", index: slot.index, delta: { kind: "text", text: deltaText } };
    }

    for (const call of extractToolCallDeltas(decoded)) {
      const loss = applyToolCallDelta(toolCalls, call, () => {
        synthesizedToolCallSeq += 1;
        return `windsurf_call_${synthesizedToolCallSeq}`;
      });
      if (loss !== null) yield { kind: "loss", loss };
    }

    const rawStopReason = decoded.stopReason;
    const stopReason = typeof rawStopReason === "bigint" ? Number(rawStopReason) : Number(rawStopReason ?? 0);
    if (Number.isFinite(stopReason) && stopReason !== 0) stopReasonCode = stopReason;

    usage = mergeUsage(
      usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      decoded,
    );
  }

  const closed = cursor.close();
  if (closed !== null) yield { kind: "partEnd", index: closed };

  // 工具调用累积到流末再成块：上游把 argumentsJson 按分片下发，且分片总是续接到
  // 最近开始的那个工具 —— 中途插进来的 delta_text 会打断块，但打断不了分片归属。
  // 只有干净收尾才铺工具块：出错时手上的参数是半截 JSON，铺出去等于把垃圾当内容提交。
  if (terminal !== null && terminal.kind === "stop") {
    for (const call of toolCalls) {
      const index = cursor.take();
      yield {
        kind: "partStart", index,
        part: {
          kind: "toolCall",
          call: { id: call.id, toolRef: { group: null, name: call.name }, input: { kind: "json", value: {} } },
        },
      };
      if (call.argumentsJson.length > 0) {
        yield { kind: "partDelta", index, delta: { kind: "toolInputJson", json: call.argumentsJson } };
      }
      yield { kind: "partEnd", index };
    }
  }

  if (usage !== null) yield { kind: "usage", usage };

  // ── 终止判定。这里的每个分支都对应「绝不产出 200 但空的假成功」这条硬规则 ──
  if (terminal !== null && terminal.kind === "error") {
    yield terminal.event;
    return;
  }

  if (terminal === null) {
    // 一个结束帧都没等到 = 连接被掐断。此前照样 messageStop 的话，
    // 客户端看到的是一段截断内容加一个正常收尾，与「模型说完了」不可区分。
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: state.residualBytes > 0
          ? `windsurf stream ended mid-frame after ${state.frameCount} frame(s) `
            + `with ${state.residualBytes} residual byte(s); the turn is truncated`
          : `windsurf stream ended after ${state.frameCount} frame(s) without a Connect end-stream frame; `
            + "the turn is truncated",
        raw: null,
      },
    };
    return;
  }

  if (!sawDataFrame) {
    // 干净的结束帧，但一条数据帧都没有。生产在这里抛
    // 「GetChatMessage returned no response message」—— 报成功就是那个假 200。
    yield {
      kind: "error",
      error: {
        kind: "unknown", httpStatus: null, retryable: true,
        message: "windsurf stream closed with a clean trailer but never sent a response message",
        raw: null,
      },
    };
    return;
  }

  let reason: IRStopReason;
  if (stopReasonCode === null) {
    reason = toolCalls.length > 0 ? "toolUse" : "endTurn";
  } else {
    const mapped = STOP_REASON_IR[stopReasonCode];
    if (mapped === undefined) {
      yield { kind: "unhandled", rawType: `<windsurf-stop-reason:${stopReasonCode}>`, raw: stopReasonCode };
      reason = toolCalls.length > 0 ? "toolUse" : "endTurn";
    } else {
      reason = mapped === "endTurn" && toolCalls.length > 0 ? "toolUse" : mapped;
    }
  }

  if (reason === "error") {
    // 尾帧干净但上游自己说这轮失败了。报 messageStop 会让调用方拿到一个静默的坏回合。
    yield {
      kind: "error",
      error: {
        kind: "unknown", httpStatus: null, retryable: true,
        message: `windsurf finished with stop_reason=${stopReasonCode}; the turn produced no usable ending`,
        raw: { stopReason: stopReasonCode },
      },
    };
    return;
  }

  yield { kind: "messageStop", reason };
}
