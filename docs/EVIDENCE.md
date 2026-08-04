# 语料证据

IR 的每条结构决策对应的实测数据。采样时间 2026-08-04。

## 语料来源

| 来源 | 规模 | 用途 |
|---|---|---|
| 生产 ClickHouse 原文归档 `relay_client_http_exchange` | 807 条分层采样（总量 112,438 条，最深 turn_index 1689） | 全量无截断的客户端请求原文 |
| 网关流量日志 `gateway-dev-*.ndjson` | 5 天 1,085,624 行 | 异常形态、跨协议覆盖 |
| codex rollout `~/.codex/sessions/` | 6 份会话 | Responses input item 的类型与键集 |

归档表 8123 端口，读取统一经 `packages/database` facade hydrate，不自行解码 payload。
网关日志单条上限 8KB，大请求被截断，因此**只用于异常统计**，结构证据全部取自归档。

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
   正是「有损发生在 ingress」这个反模式。改成三个正交维度。
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

**→ IR 影响**：`IRUpstreamError.kind` 的九个取值直接来自这张表，
每个都带 `retryable`，不让调用方从文案里猜。
