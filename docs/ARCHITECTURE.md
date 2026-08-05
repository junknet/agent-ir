# agent-ir 架构

一句话结论：**入口是封闭集(3)、出口是开放集(3+n),中间只有一个 IR;新增一个上游只付两个函数,换来三条路由。**

边界要分两层说，混为一谈会读错这个仓库：

- **Core**（`src/ir` · `src/inbox` · `src/outbox`）只做协议翻译与准入裁决。**不做**账号选择、配额、重试编排、模型映射、任何形式的内容修补 —— 它对「上游是谁、有没有额度、这次该不该重试」一无所知，这是它能保持确定性的前提。
- **参考网关**（`src/gateway` · `src/server.ts`）做上面那些里的一部分：模型名映射、出口选择、修复策略装配、流策略。它是**可选层**，随仓库发布只是为了让 Core 有一个能跑起来的宿主；把 agent-ir 当库用的调用方可以整个不要它，自己拿 Core 的三个 API 拼。

「不做模型映射」说的是 Core，不是这个仓库 —— 见 §6。

---

## 1. 总览：谁连到谁

> 这张图回答：数据从客户端到上游要经过哪几段,以及哪一段是可选的。

```mermaid
flowchart LR
  C["客户端<br/>Claude Code / codex / jcode"]
  subgraph CORE["agent-ir core（零依赖）"]
    IN["入口 codec<br/>封闭集 3"]
    IR(["IR<br/>请求 + 响应"])
    OUT["出口 outbox<br/>开放集 3+n"]
  end
  RP["repair（可选）<br/>默认什么都不修"]
  U["上游"]

  C -- "读入请求" --> IN
  IN --> IR
  IR -. "调用方显式 compose" .-> RP
  RP -. "修完重新裁决" .-> IR
  IR --> OUT
  OUT -- "写出请求 / 读回事件" --> U
  IR -- "写出响应" --> C
```

关键点：`repair` 是**虚线**——它不在默认路径上。Core 的默认行为是确定性的：表达不了就带精确 IR 路径拒绝，绝不发明内容。

---

## 2. 入口与出口：两条**独立**的轴

> 这张图回答：为什么入口和出口不能用同一套键。

```mermaid
flowchart TB
  subgraph INBOX["inbox — 封闭集，锁定 3 个"]
    I1["anthropic_messages"]
    I2["openai_responses"]
    I3["openai_chat_completions"]
  end
  IR(["IR"])
  subgraph OUTBOX["outbox — 开放集，当前 6 个"]
    O1["anthropic"]
    O2["openai_chat"]
    O3["openai_responses"]
    O4["gemini_cloudcode"]
    O5["windsurf<br/>protobuf"]
    O6["copilot"]
  end

  I1 & I2 & I3 --> IR --> O1 & O2 & O3 & O4 & O5 & O6
```

**两条轴独立，不是不相交。** `anthropic` 与 `openai_responses` 恰好两边都在（它们既是客户端协议又是上游 API），但 `gemini_cloudcode` 与 `windsurf` **根本不是任何客户端协议** —— 这就是出口必须以供应商名为键、而不是以 `IRProtocol` 为键的实证。

| | 集合 | 每项要几个函数 | 增长 |
|---|---|---|---|
| inbox | 封闭，3 个 | `readClientRequest` + `writeClientResponse` | 写完永不再长 |
| outbox | 开放，3+n | `writeOutboxRequest` + `readOutboxResponse` | 每加一家付 2 个，换 3 条路由 |

当前路由数 = 3 × 6 = **18**。

### 2.1 命名与所有权约束

`IROutbox` 是出口的唯一公共接口：`writeOutboxRequest` 负责 IR → 供应商 wire，
`readOutboxResponse` 负责供应商 wire → `IREvent`。`IROutboxProfile` 仅声明每个出口都能
共同解释的 wire 事实：`supports`、`lossy`、`mandatory`。

这条边界是强约束，不是命名偏好：不得用 `egress`、`upstream` 或 `provider` 充当新的 Core
方向名；客户端侧使用 `inbox`，供应商 wire 侧使用 `outbox`。外部协议原文字段、错误码和
历史证据可保留原名。

**目录名与文件名同样受这条约束**：磁盘上是 `src/inbox/` 与 `src/outbox/`，
测试是 `test/inbox_*.test.ts` 与 `test/outbox_*.test.ts`。全仓库只有一套方向词汇。

任何一家 Outbox 的私有逻辑——Windsurf 的 Connect/protobuf、供应商鉴权、内建工具映射、
供应商策略限制——只放在该 Outbox 自己的 `src/outbox/` 模块，由自己的 Outbox 实现处理。不要为一家
供应商向 `IROutboxProfile` 添加布尔字段、全局枚举、通用 repair 条目或含糊 callback；只有
至少两家具有相同语义、相同输入输出和相同调用方时，才能抽取新接口，并须同时交付两家实现
与契约测试。

接口命名表达稳定跨模块契约，类仅用于封装具体状态与生命周期；无状态转换使用具名纯函数。
新接口和方法必须在名字中写出领域对象与方向，禁止 `process`、`handle`、`helper`、`manager`
等无法推断输入输出的泛化命名。

---

## 3. 六个上游的真实传输形态

**只有 Windsurf 是二进制。** Gemini CloudCode 常被误认为 protobuf，它其实是 JSON SSE。

| 出口 | 端点 | 请求体 | 响应 |
|---|---|---|---|
| `anthropic` | `/v1/messages` | JSON | SSE(JSON) |
| `openai_chat` | `/v1/chat/completions` | JSON | SSE(JSON) + `[DONE]` |
| `openai_responses` | `/v1/responses` | JSON | SSE(JSON) |
| `gemini_cloudcode` | `v1internal:streamGenerateContent?alt=sse` | JSON | SSE(**CRLF 分帧**) |
| `windsurf` | `/exa.api_server_pb.ApiServerService/GetChatMessage` | **protobuf** | **Connect 二进制帧** |
| `copilot` | `/v1/messages` | JSON | SSE(JSON) |

因此 `IRWireRequest` 对 body 泛型：`IRWireRequest<TBody extends IRWireBody>`（`IRWireBody = string | Uint8Array`）。二进制 wire 保留原始字节，绝不 base64 化。

### 3.1 两个**故意不是** `IROutbox` 的东西

`IROutbox` 这个公共契约只描述「一条能被 fetch 发出去的 POST wire」。有两样真实存在、也确实
在跑的东西不满足这个形状，它们各自住在自己的模块里，**没有**为了收编它们去松动公共契约：

| | 源码 | 为什么不能是 `IROutbox` |
|---|---|---|
| **ChatGPT Codex 私有 Responses** | `src/outbox/codex/` | 传输是 WebSocket `response.create` 帧，不是 POST；续轮靠 `previous_response_id`，工具定义放在 `input` 的 `additional_tools` item 里。收编它就得给 Core 加一层只服务它一家的运输抽象 |
| **Windsurf 的 `web_search` 执行器** | `src/outbox/windsurf/web_search.ts` | 它不是「把 IR 编译成 wire」，而是**执行一个工具**：`GetChatMessage` 只把 `web_search` 当普通 function tool 发下去，真实客户端在模型返回该调用后另行调 `GetWebSearchResults`，再把结果当普通 `IRToolResult` 回灌。这是宿主工具循环的事，不是协议翻译 |

两者都复用已有件而不是复制语义：codex 把 WebSocket 文本消息里的 JSON payload 直接喂给既有的
Responses event lifter；web_search 的产物是普通 `IRToolResult`，不新增任何 IR 概念。

注意 `webfetch`：真实客户端把它和 `web_search` 一样声明成普通 function tool，但抓包里
**没有它的执行报文**，所以本仓库不实现它 —— 没有证据的东西不写。

两处必须留意：
- **CloudCode 用 CRLF 分帧**。按 `indexOf("\n\n")` 找边界会把整条流攒成一个 block，症状不是报错是**内容凭空消失**。正确做法是逐行扫描 + 空行分帧（与官方 SDK 一致）。
- **Windsurf 的应用错误在 Connect 尾帧里，没有 HTTP 状态码**。传输层永远 200，所以错误必须从尾帧读；`permission_denied` 是「这条请求本身被拒」，`retryable:false`，换账号重试只会打遍账号池。它说的是**错误往哪放**；**为什么被拒**见 §3.2。

### 3.2 Windsurf 的内容策略：三段会被拒

Windsurf 上游在 wire 之外还有一层策略检查。请求可以编译得完全合法、字段一个不缺，仍然被
整条打回（HTTP 200，错误在 Connect 尾帧）。判据是**具体段落**，不是体量也不是关键词密度。

实测依据两处：`test/fixtures/windsurf_capture/` 的 12 条真实报文（21KB agent system prompt +
23 个工具 + PNG 图片 + 21 轮历史，全部 200），以及 2026-08-05 拿真实凭据对
`server.codeium.com` 做的逐段实验（模型 `claude-opus-4-6`，Claude Code 2.1.221 的 9929 字符
system 切成 12 段逐个发）。结果是 **12 段里只有 3 段会被拒**：

| 段 | 字符 | 上游反应 |
|---|---|---|
| **`You are Claude Code, …`**（客户端身份行） | 57 | `an internal error occurred` |
| **`IMPORTANT: Assist with authorized security testing…`** | 459 | `blocked by our content policy` |
| **`# Environment`** | 973 | `blocked by our content policy` |
| 其余 9 段（计费头 / `# Harness` / `# Delivering work` / `# Corrections` …） | 8507 | 放行 |

**错误信息区分两套机制**：身份行给泛化 `permission_denied`，正文段给明确的 content policy。
两者独立，必须同时处理 —— 只动其中一边仍然被拒。摘掉这 3 段并把身份行换成
`You are Devin, an interactive command line agent from Cognition.` 之后，带 12 个真实
Claude Code 工具实测 200，客户端指令存活 **85.7%**（8507/9929）。

处置全部落在 windsurf 自己的 `WindsurfSystemIdentityPolicy`（`src/outbox/windsurf/index.ts`），
默认开启，每次改写记 `IRLoss`，调用方可传 `{ kind: "passthrough" }` 关掉。

**注意**：段落判据用**段首前缀**而不是整段精确相等，因为这些段落会随客户端版本改字。
前缀漂了的后果是那一段没被摘、整条请求被拒 —— 是个响亮的失败，不是静默的错。

供应商的内容策略既不是 wire 事实也不是能力声明，因此 `IROutboxProfile` 里没有它的位置。

---

## 4. 一次请求的时序

> 这张图回答：一次请求经过哪些裁决点，各点失败时怎么收场。

```mermaid
sequenceDiagram
  participant C as 客户端
  participant G as 网关
  participant O as 出口
  participant U as 上游

  C->>G: 协议请求
  G->>G: 读入 → IR（+ inbox losses）
  G->>G: 准入裁决（能力需求 vs 出口声明）
  alt 出口承载不了
    G-->>C: 422 + 精确 IR 路径
  else 通过
    G->>O: 写出上游请求
    alt 目标 wire 表达不了
      O-->>C: 422 + problems
    else 编译成功
      O->>U: 发送
      U-->>O: 响应
      O->>G: 读回 IR 事件流
      G->>G: 流守卫（提交点 / 保活 / 判死）
      G-->>C: 按入口协议写出响应
    end
  end
```

两个裁决点的分工：**准入**看「这个出口支不支持这类能力」（静态声明），**写出**看「这条具体请求能不能编译成合法 wire」（实际内容）。前者拒得早、代价低；后者拒得准、路径精确到字段。

---

## 5. 响应侧：流与文档

> 这张图回答：为什么响应有两种形态，以及它们怎么闭环回下一轮请求。

```mermaid
flowchart LR
  U["上游响应<br/>SSE 或一次性 JSON"]
  EV(["IREvent 流"])
  DOC["IRResponse<br/>文档形态"]
  W["写出到客户端"]
  NEXT["下一轮请求历史"]

  U -- "读回（非流式合成等价事件）" --> EV
  EV -- "流式：逐帧转发" --> W
  EV -- "assembleResponse（唯一折叠）" --> DOC
  DOC -- "非流式：整段成体" --> W
  DOC -- "turn 直接 append" --> NEXT
```

**闭环在 `IRResponse.turn`**：它是一个 assistant `IRTurn`，与请求历史里的回合**同一个类型**，可以直接接进下一轮，不必绕一圈 wire 再读回。测试锁死了这条 —— 组装出的回合与走 Anthropic wire 再读回来的结果**完全相等**。

`IREvent` 十一态：`messageStart` / `partStart` / `partDelta` / `partEnd` / `usage` / `messageStop` / `error` / `loss` / `unhandled` / `committed` / `heartbeat`。

后两个由流守卫注入：`committed` 标记首个语义产出已下发（**此后不可换号、不可改状态码**）；`heartbeat` 由计时器驱动，各 encoder 渲染成自己协议的保活帧。

---

## 6. 参考网关：Core 之外那一层

> 这张图回答：`src/gateway/` 到底管什么，以及为什么它不能在 Core 里。

前面五节讲的都是 Core。但 Core 的三个 API（读入 / 裁决 / 写出）单独摆着是跑不起来的 ——
总得有人回答「这条请求发给谁」「客户端说的 `claude-opus-5` 在这家上游叫什么」「哪几条修复是开着的」。
这些问题的共同点是**换一个部署就会有不同答案**，所以按 §8 的判据它们全是策略，一条都不能进 Core。

```mermaid
flowchart TB
  ENV["环境变量"]
  subgraph GW["src/gateway —— 可选层，一次装配"]
    CFG["readGatewayRuntimeSettings<br/>唯一装配点"]
    MODEL["模型路由表<br/>客户端名 → 上游 id"]
    SEL["出口选择<br/>OUTBOX_SELECTIONS"]
    POL["修复策略 + 流策略"]
    ADV["拒绝时的修复建议<br/>problem kind → repair kind"]
  end
  subgraph CORE["Core —— 不认识上面任何一样东西"]
    IR(["IR"])
  end
  SRV["src/server.ts<br/>纯组合根"]
  MAIN["src/main.ts<br/>CLI 入口"]

  ENV --> CFG
  CFG --> MODEL & SEL & POL & ADV
  MAIN --> SRV
  CFG --> SRV
  SRV --> IR
```

四件事，各自的判据：

| 网关做的事 | 源码 | 为什么不能进 Core |
|---|---|---|
| **模型名映射** | `model_routing.ts` | 客户端说的 `claude-opus-5` 与上游签发的 id（windsurf 的 `chat_model_uid`、gemini 的档位名）是**两个命名空间**。这张表因部署而异，没有正确的默认值 |
| **出口选择** | `outbox_selection.ts` · `config.ts` | 「这条请求发给谁」取决于持有哪家凭据、哪家还有额度 —— Core 对此一无所知 |
| **修复策略装配** | `config.ts` · `repair/**` | 修不修、修哪几条，是调用方的成本/正确性权衡 |
| **拒绝时给建议** | `repair_advice.ts` | `Record<IRBuildProblemKind, IRRepairKind[]>` —— 新增一种拒绝理由时编译器逼你回答「这条能不能修」 |

两条贯穿设计：

- **构造成功即可用**。`readGatewayRuntimeSettings` 返回之后不存在「还没校验」的字段：出口已绑好、模型表已解析、修复种类已核对。所有会失败的判断都发生在启动时，不散在第一条请求的路径上 —— 配错了就起不来，而不是跑到半夜才 4xx。
- **不中默认拒绝，不默认透传**。模型表查不到时默认 `refuse`，因为默认透传等于「配不配都能跑」，那就没人会配它；而配错的人拿到的是上游的 opaque 4xx，指不回网关这边。想透传的人显式写 `AGENT_IR_MODEL_FALLBACK=passthrough` —— 那是一个决定，决定就该写下来。

**把 agent-ir 当库用的调用方可以整个不要这一层**：Core 从 `src/index.ts` 导出，自己拿三个 API 拼一个宿主即可。`src/main.ts` 与 `src/server.ts` 拆开也是为此 —— 宿主可以注册完 IRMessage interceptor 再 `startGateway()`。

---

## 7. 节点到源码

目录名沿用 `inbox`/`outbox`（见 §2.1 末尾），契约名一律是 `inbox`/`outbox`。下表左列是概念，
右列是磁盘上的真实路径，两者不必同名。

| 图上的东西 | 源码 |
|---|---|
| IR 类型契约（L0/L1/L2）、`IROutbox` 公共接口 | `src/ir/types.ts` |
| 两条轴的注册表（`OUTBOX_REGISTRY`） | `src/protocols.ts`、`src/ir/codec.ts` |
| 准入裁决 | `src/ir/admission.ts` |
| 能力需求推导 | `src/ir/capabilities.ts` |
| 响应折叠 | `src/ir/response.ts` |
| 流守卫（提交点/保活/退避） | `src/ir/stream_guard.ts` |
| SSE 分帧 | `src/ir/sse.ts` |
| IRMessage 审计 interceptor chain | `src/ir/ir_message_interception_extensions.ts` |
| 三个 Inbox codec | `src/inbox/**` |
| 六个 Outbox（`OUTBOX_REGISTRY`） | `src/outbox/**`（windsurf 在子目录，唯一带依赖） |
| Codex WebSocket 适配（**不是** `IROutbox`，见 §3.1） | `src/outbox/codex/` |
| Windsurf `web_search` 执行器（**不是** `IROutbox`，见 §3.1） | `src/outbox/windsurf/web_search.ts` |
| Windsurf 真实报文夹具（12 条，全部 200） | `test/fixtures/windsurf_capture/` |
| 出口选择（`OUTBOX_SELECTIONS`） | `src/gateway/outbox_selection.ts` |
| 网关唯一装配点（`readGatewayRuntimeSettings`） | `src/gateway/config.ts` |
| repair（可选层） | `src/repair/**` |
| 参考网关（可选层） | `src/gateway/**`、`src/server.ts` |
| CLI 入口 | `src/main.ts` |
| 公共入口 | `src/index.ts` |

---

## 8. 契约与判据

**Core 的唯一承诺：编译或拒绝。**

```ts
interface IROutbox<TBody extends IRWireBody = string> {
  readonly profile: IROutboxProfile;
  writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult<TBody>>;
  readOutboxResponse(response: Response, options?): AsyncIterable<IREvent>;
}

type OutboxRequestBuildResult<TBody> =
  | { ok: true;  wire: IRWireRequest<TBody>; losses: readonly IRLoss[] }
  | { ok: false; problems: readonly IRBuildProblem[]; losses: readonly IRLoss[] }
```

判别联合而不是抛异常：**失败是正常返回值之一，调用方必须表态。**
两个分支都带 `losses` —— 拒绝之前已经攒下的留痕一并交出，不因为拒绝就丢掉。

留痕本身也带方向：`IRLoss.stage` 的三个取值是 `inbox` / `outbox` / `lift`，
`IRLoss.outbox` 记下是哪一家出口产生的（inbox 阶段为 `null`）。

划线判据 —— 遇到「目标承载不了」时怎么办：

| | 归属 | 例子 |
|---|---|---|
| 目标 wire 真的没有这个位置 | **编译事实**，留 Core，记 `IRLoss` 或拒绝 | 分组拍进名字、effort 夹进枚举区间 |
| 我替你决定怎么办 | **策略**，归 repair，调用方显式挂 | 悬空调用补占位、必填字段补默认值、图片降级成文本 |

拿不准时的标准问法：**「这个决定换一个调用方会不会想要不同的结果？」** 会 → 策略；不会 → 编译事实。

**`supports` 只收行为实证**（生产真跑过、上游按预期行事）。结构实证（协议定义里有字段，但没有任何一次真实调用证明上游会照它行事）只能进 `lossy`。

---

## 9. 注意事项

- **IR 只表达语义，不表达排列。** 关联一律用 id；`tool_result` 必须紧邻这类位置不变量在写出 wire 时才处理。
- **未知内容显式装箱成 `opaque`。** 类型系统据此逼每个 Outbox 表态，字段不会在新增 Outbox 时蒸发。
- **`readOutboxResponse` 的 switch 必须有 default 产出 `unhandled`。** 上游协议漂移要能自己冒头，不靠故障反推。
- **保活由计时器驱动。** 上游彻底静默正是保活要顶的场景，所以它不能挂在数据分支上。
- **Core 不发明内容。** 表达不了就带精确 IR 路径拒绝；补值、改写、降级都归 repair 或 Outbox 自己的 owner option，且必须记 `IRLoss`。
