# agent-ir

多协议 LLM 网关的协议中立 IR。三个入口协议 → 一个 IR → 任意出口。

```
POST /v1/messages          ┐                                    ┌ anthropic
POST /v1/responses         ┼─ readClientRequest ─► IR ─ writeUpstreamRequest ─┼ (下一个上游在这里加)
POST /v1/chat/completions  ┘                        ▲                        └
                                                    │
                          writeClientResponse ◄─────┴─ readUpstreamResponse
```

不是又一个「以某家 wire 格式当 IR」的网关。设计依据是**真实流量**，每条结构决策都能追到具体证据。

## 五条不变量

每条对应一个已确认的真实故障，不是理论洁癖。

| # | 不变量 | 它杜绝的故障 |
|---|---|---|
| 1 | **关联用 id，不用位置** | `tool_result` 必须紧邻/必须最前的排列战争（179 行的 `anthropic_constraints.ts` 在这里只剩一个 `arrangeToolTurns`） |
| 2 | **未知必须显式装箱** | 索引签名夹带让新增出口时字段静默蒸发 |
| 3 | **有损必须留痕** | `max_tokens` 对 codex 出口静默失效、builtins 静默丢 |
| 4 | **响应是可拉取的事件流** | 一天 126 次静默 `context_length_exceeded`，全被 switch 缺省分支吞掉，返回「200 但空」 |
| 5 | **能力是静态声明** | usage 三态坍缩（「上游不支持缓存」与「这轮没命中」不可区分） |

## 请求与响应，两侧都是 IR

请求天然是**文档**（发之前整段对话就在手上），响应天然是**流**（增量到达）。
这个不对称是 domain 固有的，但「响应组装完之后长什么样」同样必须是 IR ——
否则每个出站协议都要自己从事件流折一遍，各折各的形状。

```
请求  IRRequest              L0 会话 + L1 意图 + L2 能力需求
响应  IREvent 流             messageStart / partStart / partDelta / partEnd
                             / usage / messageStop / error / loss / unhandled
      ↓ assembleResponse()   唯一的折叠实现
      IRResponse             { turn, stopReason, usage, error, losses, unhandled }
```

**闭环在 `IRResponse.turn`**：它是一个 assistant `IRTurn`，与请求历史里的回合同类型，
可以直接 append 进下一轮的 `conversation.turns`，不必绕一圈 wire 再 decode。
`IRTurn` 对 part 类型协变，所以它同时是「比历史回合窄」（`IRResponsePart`：模型不会
生成 image / document / toolResult / opaque）和「是历史回合」。

测试锁死了这条：组装出的回合与把同一段产出走 Anthropic wire 再 decode 回来的结果**完全相等**。

流式路径不能用整段折叠（必须边收边发），但它的**收尾产物仍然是 `IRResponse`** ——
于是 envelope 构造只有一份，不因流式/非流式分叉。

## 三层结构

```
L0  Conversation   消息与内容        src/ir/types.ts
L1  Intent         控制意图 + provenance
L2  Capability     能力声明 + 损失记账   src/ir/admission.ts
```

三层正交：L0 不知道 effort 是什么，L1 不知道消息长什么样，L2 只做裁决和记账。

**L1 的每个值都带 `source`**（`client` / `gateway-default` / `gateway-forced`）——
出口据此区分「客户端明确要求」与「网关替他决定」，两者冲突时处理完全不同。

**L2 的裁决只有三条规则**：

```
need ∈ supports          → 放行
need ∈ lossy             → 放行 + 强制记一条 IRLoss
need ∉ supports ∪ lossy  → 该出口不可用（多出口换一家，单出口 422 并带精确 IR 路径）
```

## 语料与证据

- **807 条全量归档请求**（`anthropic_messages` 611 / `openai_chat_completions` 116 /
  `openai_responses` 80），来自生产 ClickHouse 原文归档，无截断，最深会话 turn_index 1689
- **5 天 108 万行网关流量日志**
- **6 份真实 codex rollout**（Responses input item 的类型与键集）

`docs/EVIDENCE.md` 逐条记录了「哪个字段出现多少次 → 因此 IR 怎么建模」。

## 跑起来

```bash
bun install

AGENT_IR_UPSTREAM_BASE_URL=https://your-upstream \
AGENT_IR_UPSTREAM_API_KEY=sk-... \
AGENT_IR_UPSTREAM_MODEL=claude-opus-5 \
bun run dev
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_IR_PORT` | `9797` | 监听端口 |
| `AGENT_IR_ENV` | `dev` | `dev` 时日志默认 debug + 彩色文本 |
| `AGENT_IR_LOG_LEVEL` | dev `debug` / 否则 `info` | `trace` 会打完整 wire body 与每个 IR 事件 |
| `AGENT_IR_LOG_FORMAT` | dev `text` / 否则 `json` | `json` 便于 jq |

一条请求的完整决策链（同一个 trace 串起来，**不需要客户端带任何 debug 头** ——
真实客户端注入不了自定义头，这是上一版踩过的坑）：

```
ingress_received → ingress_decoded → admission_decided → egress_lowered
→ upstream_responded → egress_lifted(unhandled 计数) → request_completed
```

## 测试

```bash
bun test          # 边界用例 + 请求↔响应对称性 + SSE 分帧 + 长流容错 + 807 条真实语料回放
bun run typecheck
```

语料回放需要本机 `.corpus/requests.ndjson`（含真实会话原文，不进 Git）；缺失时自动跳过。

回放断言的是**设计对不对**，不是代码跑不跑：
- 807 条真实请求 decode 无异常
- opaque 装箱率 < 0.1%（高就说明类型覆盖不够，是设计缺口）
- 16510 组工具调用/结果全部关联成功，**0 孤儿**
- 每条 loss 都是**故意**的

## 已验证

三个入口都用**完整客户端程序**打通，不是 curl：

| 入口 | 客户端 | 形态 |
|---|---|---|
| `/v1/messages` | Claude Code 2.1.221 | `--bare` 单轮 + 全量 237 工具的多轮工具调用 |
| `/v1/responses` | codex 0.146.0 | 228KB 请求、247 工具、14 个 namespace 分组 |
| `/v1/chat/completions` | jcode | 219KB 请求、230 工具 |

出口侧已接五家：`anthropic` · `openai_chat` · `openai_responses` · `gemini_cloudcode` · `windsurf`，
因此当前可用路由是 3 入口 × 5 出口 = 15 条。Windsurf 使用统一的
ConnectRPC/Protobuf `GetChatMessage` outbox；模型家族只由 `chat_model_uid` 选择，不另拆出口。

codex 那条同时验证了 L2：namespace 分组在 Anthropic 出口只能拍进名字，
`ir_loss_recorded` 显式记下 `'toolGroup' only with loss of fidelity` ——
旧设计里这个损失完全静默，还得配一个平行的还原 Map。

## 加一个出口

实现 `IREgress`：

```ts
interface IREgress {
  readonly profile: IREgressProfile;              // supports / lossy 静态声明
  lower(request: IRRequest): Promise<IRLowerResult>;   // IR → wire + losses
  readUpstreamResponse(response): AsyncIterable<IREvent>;              // 上游响应 → IR 事件流
}
```

两条硬要求：

1. `readUpstreamResponse` 的 switch **必须有 default 产出 `{kind:'unhandled'}`**。上游协议漂移要能自己冒头，
   不能等故障反推。
2. 任何丢弃/降级/替换都要 `IRLoss`。「这个字段这个上游不支持」是设计信息，不是可以省略的细节。
