# 语料证据

IR 的每条结构决策对应的实测数据。采样时间 2026-08-04。

## 语料来源

| 来源 | 规模 | 用途 |
|---|---|---|
| 生产 ClickHouse 原文归档 `relay_client_http_exchange` | 807 条分层采样（总量 112,438 条，最深 turn_index 1689） | 全量无截断的客户端请求原文 |
| 网关流量日志 `gateway-dev-*.ndjson` | 5 天 1,085,624 行 | 异常形态、跨协议覆盖 |
| codex rollout `~/.codex/sessions/` | 6 份会话 | Responses input item 的类型与键集 |
| Devin CLI 抓包 `test/fixtures/windsurf_capture/` | 12 条 `GetChatMessage` 请求 | Windsurf 出站 protobuf 信封的字段使用情况 |

归档表 8123 端口，读取统一经 `packages/database` facade hydrate，不自行解码 payload。
网关日志单条上限 8KB，大请求被截断，因此**只用于异常统计**，结构证据全部取自归档。

前三行都是**入站**证据（客户端发给网关的原文），只有最后一行是**出站**证据
（网关发给供应商的 wire）。两者不能互相替代：入站语料决定 IR 要装得下什么，
出站抓包决定某个 Outbox 的 `profile` 能声明什么。

## 协议分布（807 条采样）

```
anthropic_messages/copilot        606
openai_chat_completions/windsurf  116
openai_responses/windsurf          80
anthropic_messages/windsurf         5
```

## 顶层字段

| 协议 | 字段（出现次数） |
|---|---|
| anthropic_messages | `model` 611 · `messages` 611 · `max_tokens` 611 · `system` 568 · `thinking` 559 · `tools` 519 · `stream` 491 · `metadata` 365 · `output_config` 355 · `tool_choice` 169 · `context_management` 149 · `temperature` 25 · `stop_sequences` 9 |
| openai_chat_completions | `model` 116 · `messages` 116 · `stream` 116 · `max_tokens` 95 · `temperature` 94 · `reasoning_effort` 93 · `tools` 74 · `stream_options` 20 |
| openai_responses | `model` 80 · `input` 80 · `stream` 80 · `instructions` 32 · `store` 32 · `tool_choice` 29 · `parallel_tool_calls` 29 · `reasoning` 27 · `tools` 9 · `include` 9 · `prompt_cache_key` 9 |

**→ IR 影响**：`output_config`（355 次）与 `context_management`（149 次）都是高频字段，
最初的设计里完全没有这两个维度，是语料逼出来的 L1 扩展。

## 系统提示有三个载体

```
anthropic_messages   顶层 system: array 420 / string 148
                     messages 里 role:'system'      1537
openai_chat          messages 里 role:'system'        83
openai_responses     instructions:string              32
                     input 里 role:'developer'         9
```

**→ IR 影响**：`role` 只保留 `user`/`assistant`；三个载体全部归位到 `conversation.system`，
且永远是 `IRPart[]`（string 形态在 decode 时消灭）。

## 内容块类型

```
anthropic_messages   tool_use@assistant 14155 · tool_result@user 14155 · text@assistant 8158
                     thinking@assistant 2959 · <string>@system 1652 · text@user 1497
                     text@system 1115 · <string>@user 922 · <string>@assistant 23 · image@user 8
openai_chat          <string>@tool 2355 · <string>@assistant 2231 · <string>@user 474
                     <string>@system 83 · image_url@user 16 · text@user 16
openai_responses     input_text@user 103 · input_image@user 54 · input_text@developer 27
```

**→ IR 影响**：
- `role:'tool'` 是 Chat 里出现最多的角色（2355）——工具结果作为独立消息，
  并行调用产生连续多条，必须在 IR 边界合并，否则 lower 回 Anthropic 会被判「漏了结果」。
- `<string>@assistant` 23 次：assistant 的 content 也可能是裸字符串，不能假设恒为数组。
- 图片三种载体：`image`（base64 source）/ `image_url`（嵌套对象）/ `input_image`（裸字符串 URL）。

## assistant 回合形态（27 种）

```
text+tool_use                          5568
tool_use                               3034
thinking+text+tool_use                 1188
thinking+tool_use                       768
thinking+tool_use+tool_use              403
…
thinking+text+tool_use×8                  8
text+text+tool_use                        1
```

**→ IR 影响**：`parts` 是**无约束序列**。任何「最多一个 text」「工具调用必须在末尾」
「thinking 只能在最前」的假设都会被真实流量打破。

## 并行工具调用是常态

```
anthropic  2 个 1292 · 3 个 193 · 4 个 48 · 5+ 43（最高一条 9 个）
chat       parallel 202 / single 1951
```

## 工具结果

```
content 是 string        13530
content 是 array           625   其中 inner:text 545 · inner:image 94
is_error:true              709
```

**→ IR 影响**：`IRToolResult.parts: IRPart[]` 而非 string；`status: 'ok'|'error'|'missing'`
是一等状态（错误结果是常态不是异常）。

## 工具定义形态

```
anthropic   bare input_schema        8705
            type:'custom'              13   ← 实测三例**全部带 input_schema**
            type:'computer_20251124'    1
            defer_loading:true         67
chat        type:'function'         16802（schema 在 function.parameters）
responses   type:'function'            72（strict 72 · parameters 72）
            type:'namespace'            9   ← 嵌套 tools[]，结构化分组
            type:'web_search'           9   ← **没有 name 字段**
```

实测样本：

```json
{"type":"custom","name":"bash","description":"Execute a bash command in the working directory.",
 "input_schema":{"properties":{"command":{"type":"string"}},"required":["command"],"type":"object"}}

{"type":"namespace","name":"multi_agent_v1","description":"Tools for spawning and managing sub-agents.",
 "tools":[{"type":"function","name":"close_agent",...}]}

{"type":"web_search","external_web_access":false}
```

**→ IR 影响**：
- `IRTool` 三态：`function` / `freeform` / `builtin`。`type:'custom'` **带 schema 时是 function**
  ——一律当 freeform 会丢掉整个参数契约（这是语料抓到的一个真 bug）。
- `IRToolRef { group, name }`：namespace 是**结构**，不是名字前缀。消灭 `${ns}${name}` +
  平行还原 Map。codex rollout 里 `function_call` 也带独立的 `namespace` 字段，互相印证。
- builtin 允许无 name，以 type 兜底，否则 `web_search` 会因缺名被整条丢掉。

## 控制字段实测形态

```json
thinking            {"type":"disabled"}
                    {"type":"adaptive","display":"summarized"}
output_config       {"effort":"high"}
                    {"effort":"high","format":{"type":"json_schema","schema":{...}}}
context_management  {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}
tool_choice         {"name":"audit","type":"tool"}
metadata            {"user_id":"{\"device_id\":\"…\",\"account_uuid\":\"\",\"session_id\":\"…\"}"}
reasoning           {"summary":"auto"}            (responses)
stream_options      {"include_usage":true}        (chat)
tool_use.caller     {"type":"direct"}             ← **是对象，不是字符串**
```

**→ IR 影响（两处关键修正）**：

1. `thinking:{type:'adaptive'}` 与 `output_config:{effort:'high'}` **在同一条请求里共存**。
   最初把 mode/effort/budget 建成互斥的判别联合，会在 decode 阶段就丢掉其中一个 ——
   正是「有损发生在 inbox」这个反模式。改成三个正交维度。
2. `caller` 是对象 `{type:'direct'}`；按字符串读会静默丢掉整个字段。

## 缓存断点出现在五个位置

```
system 690 · user 302 · assistant 17 · tool_use 15 · tool_result 268
```

**→ IR 影响**：`cacheBreakpoint` 是 **part 级标注**，不是 message 级开关。

## 否定证据（重要）

真实客户端流量里**完全没有出现**：

```
orphan tool_result          0
dangling tool_use           0
tool_result 没有 id          0
tool_result 不在最前          0（tool_result_first=true 12135 次）
```

但 `mixed_user_turn: text+tool_result` 有 77 次（tool_result + system-reminder 文本混排）。

**→ IR 影响**：这些畸形**不是客户端发的，是协议转换过程中产生的**。
所以 IR 内部用 id 关联是对的：畸形只可能在 lower 到 Anthropic wire 时出现，
在那里统一修一次（`arrangeToolTurns`），三个入口都不需要各自维护排列规则。

## 异常形态（网关日志 216 条 error）

```
 64  openai-compat 429  quota exceeded
 42  anthropic     401  authentication_error
 25  transport     "Unable to connect"
 27  anthropic     503  overloaded（三个模型各 9 条）
 15  antigravity   400  invalid argument
  8  anthropic     429  rate_limit_error
  8  anthropic     400  invalid_request_error
  4  transport     "socket connection closed unexpectedly"
  1  anthropic     400  "`tool_use` ids were found without `tool_result` blocks immediately after"
  1  anthropic     400  "unexpected `tool_use_id` found in `tool_result` blocks"
```

最后两条正是不变量 1 要根除的那类故障 —— 它们由转换产生，不由客户端产生。

**→ IR 影响**：`IROutboxError.kind` 的九个取值直接来自这张表，
每个都带 `retryable`，不让调用方从文案里猜。

---

# Windsurf 真实抓包（出站 wire）

来源：真实 Devin CLI 一次完整会话，`test/fixtures/windsurf_capture/` 12 条
`GetChatMessage` 请求，凭据已抹除。**12 条全部得到上游 HTTP 200。**

**这份 fixture 只含请求侧报文。** 下面凡是标着「请求侧」的数字都可以用
`getSharedWindsurfSchema()` 对仓库里的 fixture 重新解码复算；标着「响应侧」的
（2107 帧、`deltaThinking` 分布、Connect 尾帧）来自**同一次抓包会话**但报文未入库，
在本仓库内**无法复算**。引用响应侧数字时要知道它的证据等级低一档。

判空口径：`bytes` 按 `length`、`repeated` 按 `length`、`string` 按 `!== ""`。
这条很重要 —— 早期统计脚本对 `bytes` 字段写了 `(v ?? "") !== ""`，空 `Uint8Array`
恒不等于 `""`，于是把一个从未使用的字段统计成了 100% 出现率（见下面 `geminiThoughtSignature`）。

## 请求顶层字段（12 条）

```
prompt 12 · chatMessagePrompts 12 · chatModelUid 12 · requestType 12 · cascadeId 12
plannerMode 12 · metadata 12 · configuration 12 · trajectoryReference 12
tools 11 · executionId 11
```

`GetChatMessageRequest` 有 26 个字段，实测只用到 11 个。**全程为空**的包括
`useInternalChatModel` / `internalChatModel` / `disableParallelToolCalls` / `chatModelName` /
`promptId` / `providerSource` / `language` / `toolChoice` / `systemPromptCacheOptions`。

**→ IR 影响**：`toolChoice` 与 `systemPromptCacheOptions` 在 FDS 里有定义、在抓包里零使用。
按 §8 的判据（`supports` 只收行为实证），它们只能进 `lossy` 或直接判不可用，
不许因为「proto 里有这个字段」就写进 `supports`。这正是 windsurf 出口把
`toolChoiceSpecific` 判为不可用的实证依据。

## 三个模型家族共用同一个信封

```
kimi-k3-high           6 条
gpt-5-6-terra-high     3 条
gemini-3-6-flash-high  2 条
swe-1-6-fast           1 条
```

四个家族除 `chatModelUid` 外**信封逐字段同构**：同一组顶层字段、同一个
`ChatMessagePrompt` 形状、同一套 `ChatToolDefinition`。

**→ IR 影响**：模型家族**不构成新的 Outbox**。一个 `windsurf` 出口 + `chat_model_uid`
足够，拆成 `windsurf_gemini` / `windsurf_kimi` 只会把同一份编码逻辑复制三遍。

## system prompt 体量与身份

```
20945 字符   6 条（kimi）
21599 字符   3 条（gpt）
21593 字符   2 条（gemini）
  202 字符   1 条（swe-1-6-fast，会话标题生成器，tools 为空）
```

11 条 agent 请求的 system prompt 第一行完全一致：

```
You are Devin, an interactive command line agent from Cognition.
```

**→ IR 影响**：system prompt 走 `GetChatMessageRequest.prompt`（顶层 `string`），
不是 `chatMessagePrompts` 里的一个回合 —— 尽管 `ChatMessageSource` 枚举里存在
`CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT`(5)，实测**一次都没用过**。IR 的
`conversation.system` 必须降到顶层 `prompt`，降到回合列表里是错的。

同时这组数字**证伪**了一个此前被当成事实的说法 —— 见文末「一条被证伪的说法」。

## 工具：23 个，只用三个字段

`ChatToolDefinition` 有 11 个字段，253 条工具定义（23 × 11 条请求）里只有三个非空：

```
name 253 · description 253 · jsonSchemaString 253
```

**全空**：`serverName` / `strict` / `attributionFieldNames` / `readOnlyHint` /
`computerUseConfig` / `isCustomTool` / `customToolGrammar`。

`jsonSchemaString` 是**序列化后的 JSON 字符串**，不是嵌套消息。253 条全部解析得开，
顶层键恒为 `{type, properties, additionalProperties}`（`required` 220 条）。
零参工具（`mcp_list_servers`）也带一份 `"properties":{}`，而不是空字符串。

23 个工具名：

```
ask_user_question · edit · exec · find_file_by_name · get_output · grep
mcp_call_tool · mcp_list_servers · mcp_list_tools · mcp_read_resource
notebook_edit · notebook_read · read · read_subagent · request_scope
run_subagent · skill · todo_write · web_search · webfetch · write · write_to_process
```

**→ IR 影响（两条）**：

1. **`web_search` / `webfetch` 在这里是普通声明工具，不是上游内建工具。** 它们和 `exec`
   一样只有 `name`/`description`/`jsonSchemaString`，由客户端自己执行（同一次抓包里另有
   2 条 `GetWebSearchResults` RPC 就是执行体）。所以 windsurf 出口把 `IRTool` 的
   `builtin` 一律判为不可承载是对的 —— 这条 wire 上根本没有「内建」这个概念。
2. **MCP 不靠 `serverName` 分组。** 真实客户端用 `mcp_call_tool` / `mcp_list_tools` /
   `mcp_list_servers` / `mcp_read_resource` 四个元工具把整个 MCP 收进四个普通函数，
   `serverName` 字段一次都没用。IR 的 `IRToolRef.group` 在这个出口没有承载位，
   只能拍进名字并留痕。

## 回合字段（135 个回合）

```
messageId 135 · source 135 · prompt 124 · thinking 39
toolCallId 23 · toolCalls 17 · images 11 · signature 2 · signatureType 2
```

`source` 三态（`ChatMessageSource` 枚举有 6 个取值，实测只用 3 个）：

```
CHAT_MESSAGE_SOURCE_USER   (1)  72
CHAT_MESSAGE_SOURCE_SYSTEM (2)  40   ← 这是 assistant，不是 system prompt
CHAT_MESSAGE_SOURCE_TOOL   (4)  23
```

**→ IR 影响**：`CHAT_MESSAGE_SOURCE_SYSTEM` 在这套 proto 里指的是**模型产出的回合**，
名字具有误导性。按字面把 IR 的 `conversation.system` 映到它，会让 system prompt
变成一条 assistant 消息。这是一个只能靠抓包发现的陷阱，proto 名字本身读不出来。

`prompt` 在 11 个回合上为空 —— 全部是「只有工具调用、没有正文」的 assistant 回合。
**→ IR 影响**：`prompt` 是 `string` 不是 optional message，空字符串就是「没有正文」，
不能靠 `prompt` 是否存在来判断回合类型，只能看 `source` + `toolCalls`/`toolCallId`。

## thinking / signature：不是跨家族普遍事实

```
thinking       39/135
signature       2/135   signatureType 恒为 "openai"
```

两条 `signature` 都出现在 `gemini-3-6-flash-high` 的请求里，`signatureType` 却是
`"openai"`，内容是一段 JSON 数组（`[{"id":"rs_...","summary":[...]}]`）。

**→ IR 影响**：`signatureType` 与 `chatModelUid` **不相关**，不能从模型名推签名格式；
它必须作为独立字段透传。IR 侧 `signature` 是不透明字节串，出口不解释内容。

**尚未验证**：`deltaThinking` 在响应侧于 kimi / gpt / swe 上大量出现，但在
`gemini-3-6-flash-high` 的两条流上是 **0**。样本只有 2 条，不足以断言
「gemini 家族不回流 thinking」—— 只能记「未观察到」，不能记「不支持」。

## geminiThoughtSignature：FDS 里有，真实抓包零使用

```
geminiThoughtSignature   0/135   （字段 #17，类型 bytes）
```

**这个字段在 12 条报文里从未非空。** 请求侧 135 个回合、响应侧 2107 帧全为空。

早期统计脚本报告它的出现率是 **100%**，那是假阳性：判空写成 `(v ?? "") !== ""`，
而它是 `bytes`，空 `Uint8Array !== ""` 恒为真。

**→ IR 影响**：**没有**。按 §8 的判据，这是纯结构实证（proto 定义里有字段，没有任何一次
真实调用证明上游会照它行事），既不进 `supports` 也不构成往 IR 加落点的理由。
把它和 Gemini CloudCode 的 `thoughtSignature`（那个有实测流量、有真实签名值）
混为一谈是错的 —— 两者同名，但一个有行为实证、一个没有。

## 图片形状

```
images 11 条，全部挂在 CHAT_MESSAGE_SOURCE_USER 回合上
ImageData 非空字段：base64Data 11 · mimeType 11
mimeType 恒为 "image/png"，base64Data 5868 ~ 7024 字节
```

`ImageData` 的其余字段全空。图片与正文**共存于同一个回合**（`prompt` 83~89 字符 + `images`），
不是独立的一条消息；也从未出现在工具结果回合上。

**→ IR 影响**：图片是 part 而不是 message，IR 的 `IRTurn.parts` 里 `text` 与 `image`
并列这个建模与 wire 直接对应。工具结果里带图片（Anthropic 语料里有 94 次）在这条 wire 上
**没有承载位**，只能拒绝或降级并留痕。

## 工具调用与工具结果

```
ChatToolCall 非空字段：id 23 · name 23 · argumentsJson 23   （23/23 全带三样）
工具结果回合：source=TOOL + toolCallId 非空 + prompt 是纯文本
toolResultIsError：0/23 为 true
```

工具结果的正文走 `prompt`（`string`），**没有** parts 结构；
`argumentsJson` 同样是序列化后的 JSON 字符串。

**→ IR 影响（两条）**：

1. IR 的 `IRToolResult.parts: IRPart[]` 在这条 wire 上必须折成一个字符串。
   多 part 或非文本 part 是**有损**的，必须留痕。
2. `toolResultIsError` 字段**存在**且这 23 条恒为 `false` —— 只观察到了 happy path。
   「上游会不会照它行事」没有实证，因此 `status:'error'` 只能进 `lossy`，不能进 `supports`。

## configuration 实测值

```
numCompletions 1 · maxNewlines 400 · temperature 1 · firstTemperature 0
topK 40 · topP 0.949999988079071 · seed 0 · serviceTier ""
maxTokens  128000（10 条） / 65535（2 条，均为 gemini-3-6-flash-high）
```

`CompletionConfiguration` 其余字段（`minLogProbability` / `stopPatterns` /
`fimEotProbThreshold` / `lastMessageIsPartial` / `returnLogprob` …）全为默认零值。

**→ IR 影响（两条）**：

1. **`maxTokens` 是客户端按模型算出来的，不是常量。** 同一个客户端对 gemini 发 65535、
   对其余发 128000。出口不能硬编码一个 `maxTokens` 默认值，也不能把它当模型无关的常量 ——
   客户端没给 `maxOutputTokens` 时，这个字段没有「正确的默认值」可填。
2. `topP` 的实测值是 `0.949999988079071` —— 这是 `float` 而非 `double` 的精度残留。
   IR 侧存 `number`（f64），编码回 protobuf 的 `float` 时会重新截断，**往返不是位相等**。
   断言 wire 字节时必须用编码后的值比，不能用 IR 里的 `0.95` 比。

## metadata 实测值

```
ideName "chisel" · extensionName "chisel" · ideVersion "3000.2.17"
extensionVersion "3000.2.17" · locale "en" · os "linux"
apiKey <已在 fixture 中抹除> · f <一段 732 字符的十六进制串，未解析>
```

`Metadata` 有 30 个字段，实测只用到这几个；`sessionId` / `userId` / `requestId` /
`userAgent` / `deviceFingerprint` 等**全空**。

**→ IR 影响**：IR 的 `intent.identity`（device_id / account_uuid / session_id）
在这条 wire 上**没有对应承载位** —— `Metadata` 里那几个同名字段真实客户端根本不填。
按不变量 3，整段身份只能丢弃并各记一条 loss，不许硬塞进 `userId` 假装送到了。

---

## 一条被证伪的说法

此前被当成事实、并在代码注释里引用过的说法：

> Windsurf 上游的内容分类器会因为 agent 脚手架的体量或关键词密度拒掉整条请求。

**这 12 条抓包证伪了它。** 21KB 的 agent system prompt（含大量 `exec` / `write` /
`run_subagent` 这类高危关键词）、23 个工具、PNG 图片、最长 21 轮历史、最大单条报文 102KB ——
**全部 HTTP 200**，9 条有响应体的流其 Connect 尾帧全是干净的 `{}`。
体量与关键词密度不是判据。

抓包唯一测到的差别是**客户端身份**：真实客户端的 system prompt 第一行是
`You are Devin, an interactive command line agent from Cognition.`

**抓包证明到此为止。** 以下都是推断，**没有任何实测支持**，不许当结论引用：

| 说法 | 状态 |
|---|---|
| 21KB agent 脚手架 + 23 工具 + 图片会被拒 | **已证伪**（12/12 得到 200） |
| 真实客户端身份行是 `You are Devin, …` | **已实证**（11/11 条 agent 请求逐字一致） |
| 四个模型家族共用同一信封 | **已实证**（12 条逐字段同构） |
| 「只替换身份行就足够」 | **未验证** —— 从没有人做过对照实验。抓包里身份行与其余 21KB 正文同时出现，分不开哪一部分在起作用 |
| 「上游根本不看 prompt 内容」 | **未验证** —— 12 条全 200 只说明这 12 条没被拒，证伪不了「存在会被拒的输入」 |
| 被拒时的具体判据是什么 | **未知** —— 这批抓包里一条被拒的样本都没有，没有反例就没有判据 |

**→ IR 影响**：只有一条，而且是消极的。供应商的内容策略既不是 wire 事实也不是能力声明，
`IROutboxProfile` 里没有它的位置。上面那些未验证的推断**不构成**往 profile 加字段、
加开关或加 repair 条目的理由 —— 要加，先拿一条被拒的报文来。
