# agent-ir：贡献约束

先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。本仓库的唯一主线是：三个固定 Inbox
协议经 IR 路由到开放的 Outbox 集合。动手前先确认改动归属；没有明确归属的概念不得新增。

## 术语与方向

- 客户端进入网关、客户端收到的协议字节，一律是 **Inbox**。
- 网关向供应商发出的请求、从供应商读回的 wire 响应，一律是 **Outbox**。
- 公共类型和方法必须携带这一方向：`IROutbox`、`IROutboxProfile`、
  `writeOutboxRequest`、`readOutboxResponse`。
- 不得在新的 Core API、字段、方法或类型名中使用含糊的 `egress`、`upstream`、`provider`
  来代替方向。供应商协议的原始字段名、外部错误码和引用原文可以保留其原名。

## 接口边界

- `IROutbox` 是 Outbox 的唯一公共实现契约；每个 Outbox 只需实现
  `writeOutboxRequest` 与 `readOutboxResponse`，并声明 `IROutboxProfile`。
- `IROutboxProfile` 只描述所有 Outbox 共同可解释的 wire 事实：`supports`、`lossy`、
  `mandatory`。不得向其中加入某一家供应商的内容策略、账户行为、模型怪癖或临时开关。
- 某个供应商独有的编码、鉴权、工具映射、响应解码、重试判定或兼容逻辑，必须留在该供应商
  自己的 `src/outbox/` 模块，并通过它的 `writeOutboxRequest` / `readOutboxResponse`
  与外部发生关系。
- 不得为了一个 Outbox 的问题新增全局枚举、布尔 profile 字段、通用 callback 或 repair gate。
  只有当至少两个 Outbox 具有**同一语义、同一输入输出契约、同一调用方**时，才可以提出新的
  通用接口；提交中必须同时给出两家实现与契约测试。

## 类型、类与命名

- interface 只表达稳定的跨模块契约；名称必须是完整领域名词，不能用 `Config`、`Data`、
  `Info`、`Manager`、`Helper`、`Handler` 充当语义。
- class 只承载需要封装状态或生命周期的具体实现；无状态的转换与裁决使用具名纯函数，
  不得为了分组而创建 class。
- 方法名必须含对象和方向：`readInbox…`、`writeOutbox…`、`create…Outbox`；禁止
  `process`、`handle`、`convert`、`do` 等无法从名称判断输入输出的动词。
- 新的可选行为必须归属明确的 owner option 或明确的 interceptor chain；不得以开放对象、
  名称含糊的 callback 或 `any` 绕过契约。

## 实现与验收

- Core 默认“编译或拒绝”。任何降级、补值、改写客户端内容都是显式策略，必须产出 `IRLoss`
  或精确 `IRBuildProblem`，不得静默修改。
- 修改公共契约时，先更新 `src/ir/types.ts` 与 `docs/ARCHITECTURE.md`，再让 TypeScript
  枚举所有消费者；不得保留旧名称 alias 或兼容包装。
- 每个 Outbox 特化都要在相应 `test/outbox_<outbox>.test.ts` 覆盖 wire 形状、失败边界和
  不影响其他 Outbox 的反例。
- 交付前至少执行：`bun run typecheck`、`bun test`、`git diff --check`；并搜索已废弃名称，
  预期残留为零。
