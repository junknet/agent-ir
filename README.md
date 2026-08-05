# agent-ir

多协议 Agent 网关的协议中立 IR。默认内置三个行业主流对话入口：**三个 Inbox → 一个 IR → 开放 Outbox**。

完整架构图（总览 / 请求时序 / 事件流 / 源码映射）见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

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


**闭环在 `IRResponse.turn`**：它是一个 assistant `IRTurn`，与请求历史里的回合同类型，
可以直接 append 进下一轮的 `conversation.turns`，不必绕一圈 wire 再读回。
`IRTurn` 对 part 类型协变，所以它同时是「比历史回合窄」（`IRResponsePart`：模型不会
生成 image / document / toolResult / opaque）和「是历史回合」。

测试锁死了这条：组装出的回合与把同一段产出走 Anthropic wire 再读回来的结果**完全相等**。

流式路径不能用整段折叠（必须边收边发），但它的**收尾产物仍然是 `IRResponse`** ——
于是 envelope 构造只有一份，不因流式/非流式分叉。流程图见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

## 默认 Inbox：三个可直接使用的端点

这是 Agent 对话/工具循环的主流兼容组合，而非宣称存在一个跨厂商的正式统一标准。入口是封闭集，
出站供应商 wire 是开放集；新增 Outbox 不会增加新的客户端端点。

| HTTP endpoint | IR protocol | 面向的客户端生态 |
|---|---|---|
| `POST /v1/messages` | `anthropic_messages` | Anthropic Messages / Claude |
| `POST /v1/responses` | `openai_responses` | OpenAI Responses（agent-native） |
| `POST /v1/chat/completions` | `openai_chat_completions` | **OpenAI-compatible / Chat Completions** |

第三项固定称为 **OpenAI-compatible**，不称 “OpenAI-compact”。三条路径都由
`INBOX_PATH_BY_PROTOCOL` 单一注册表派生并已在服务器默认启用。

## IRMessage 审计 interceptor chain（内置）

`createIRMessageInterceptionExtensions()` 提供三条 OkHttp 风格、注册顺序确定的强类型 interceptor
chain。每环拿到
同一 IR/SSE 对象的可变引用（不是 JSON 副本）和一次性的 `chain.proceed(value)`；下行按注册顺序、
上行按相反顺序返回。request 修改返回后会重算 `requires`。

| 点位 | 时机 | 用途 |
|---|---|---|
| `inboxRequestInterceptorChain` | decode 后、路由/repair/outbox 前 | 修改或以 `IRRequestInterceptionRejected` 阻断 IR 请求 |
| `outboxSseFrameInterceptorChain` | TCP buffer 积累到完整 SSE 帧后、outbox lift 前 | 实时审计/修改尚未解析的 SSE `event` / `data` |
| `inboxCompletedResponseInterceptorChain` | 完整 `IRResponse` 形成时 | 流式在 inbox done/error 字节前；非流式在 inbox JSON 编码前 |

SSE 不按网络 chunk 或任意换行回调。共享 `iterateSse` 会跨 chunk 缓冲，逐行识别 CRLF/LF/CR，
只在**空行结束一个 SSE frame**时执行 `outboxSseFrameInterceptorChain`。已经发送给客户端的流式
delta 无法追回；要改实时正文必须使用该链，`inboxCompletedResponseInterceptorChain` 适合最终文档和
终止状态的审计。

宿主注册后启动即可把三点接进真实网关路径：

```ts
import {
  createIRMessageInterceptionExtensions,
  IRRequestInterceptionRejected,
  startGateway,
} from "agent-ir";

const irMessageInterceptionExtensions = createIRMessageInterceptionExtensions();
irMessageInterceptionExtensions.inboxRequestInterceptorChain.addInterceptor({
  interceptorId: "security-audit",
  async intercept(request, context, chain) {
    // 原地审计/修改 request；不调用 proceed 可短路剩余审计环。
    // 要拒绝 HTTP 请求则 throw new IRRequestInterceptionRejected(403, "policy_denied", "...")。
    return chain.proceed(request);
  },
});
irMessageInterceptionExtensions.outboxSseFrameInterceptorChain.addInterceptor({
  interceptorId: "sse-security-audit",
  async intercept(frame, context, chain) {
    // frame.data 已在空行处完整缓冲；原地修改后再继续 outbox lift。
    return chain.proceed(frame);
  },
});
irMessageInterceptionExtensions.inboxCompletedResponseInterceptorChain.addInterceptor({
  interceptorId: "completed-response-audit",
  async intercept(response, context, chain) {
    // 流式和非流式共用这个完整 IRResponse 点位。
    return chain.proceed(response);
  },
});
startGateway(process.env, irMessageInterceptionExtensions);
```

## 语料与证据

- **807 条全量归档请求**（`anthropic_messages` 611 / `openai_chat_completions` 116 /
  `openai_responses` 80），来自生产 ClickHouse 原文归档，无截断，最深会话 turn_index 1689
- **5 天 108 万行网关流量日志**
- **6 份真实 codex rollout**（Responses input item 的类型与键集）
- **12 条真实 Devin CLI 的 Windsurf `GetChatMessage` 抓包**（`test/fixtures/windsurf_capture/`，
  凭据已抹除，全部 HTTP 200）—— 出站 protobuf 信封侧的唯一一手证据

`docs/EVIDENCE.md` 逐条记录了「哪个字段出现多少次 → 因此 IR 怎么建模」。

## 跑起来

```bash
bun install

AGENT_IR_OUTBOX=openai_chat \
AGENT_IR_OPENAI_CHAT_BASE_URL=https://api.openai.com/v1 \
AGENT_IR_OPENAI_CHAT_API_KEY=sk-... \
AGENT_IR_MODEL_FALLBACK=passthrough \
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
inbox_received → inbox_decoded → admission_decided → outbox_lowered
→ outbox_responded → outbox_lifted(unhandled 计数) → inbox_response_completed
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

出口侧已接六家：`anthropic` · `openai_chat` · `openai_responses` · `gemini_cloudcode` · `windsurf` · `copilot`，
因此当前可用路由是 3 入口 × 6 出口 = 18 条。Windsurf 使用统一的
ConnectRPC/Protobuf `GetChatMessage` outbox；模型家族只由 `chat_model_uid` 选择，不另拆出口 ——
这条有抓包实证：12 条真实报文覆盖 kimi / gpt / gemini / swe 四个家族，除 `chat_model_uid`
外信封逐字段同构（见 `docs/EVIDENCE.md`）。

codex 那条同时验证了 L2：namespace 分组在 Anthropic 出口只能拍进名字，
`ir_loss_recorded` 显式记下 `'toolGroup' only with loss of fidelity` ——
旧设计里这个损失完全静默，还得配一个平行的还原 Map。

## 加一个出口

实现 `IROutbox`：

```ts
interface IROutbox {
  readonly profile: IROutboxProfile;              // supports / lossy 静态声明
  writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult>; // IR → wire + losses
  readOutboxResponse(response, options?): AsyncIterable<IREvent>;              // 上游响应 → IR 事件流
}
```

`IROutboxProfile` 只声明所有 Outbox 都能共同解释的 wire 事实（`supports` / `lossy` / `mandatory`）。
供应商自己的鉴权、编码、内建工具映射、内容策略统统留在该出口的 `src/outbox/` 模块里，
不往 profile 上挂布尔开关 —— 判据见 [AGENTS.md](AGENTS.md) 的「接口边界」。

三条硬要求：

1. `readOutboxResponse` 的 switch **必须有 default 产出 `{kind:'unhandled'}`**。上游协议漂移要能自己冒头，
   不能等故障反推。
2. 任何丢弃/降级/替换都要 `IRLoss`。「这个字段这个上游不支持」是设计信息，不是可以省略的细节。
3. `test/outbox_<outbox>.test.ts` 要覆盖三样：wire 形状、失败边界（编译拒绝 + 错误分类），
   以及**不影响其他 Outbox 的反例**。第三样最容易漏：一条特化如果没人证明它不外溢，
   下一个人就会把它当通用规则上提进 Core。反例长这样 —— 同一条 IR 换一个出口，
   结局必须不同（Anthropic 给空工具结果补 `""`，`openai_chat` / `openai_responses`
   在同一条 IR 上必须拒绝）。
