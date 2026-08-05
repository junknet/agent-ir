# windsurf_capture —— 12 条真实 `GetChatMessage` 请求字节

## 来源

mitmproxy 抓自真实 Devin CLI（`ideName=chisel`，`ideVersion=3000.2.17`）与
`server.codeium.com` 的会话，端点是
`/exa.api_server_pb.ApiServerService/GetChatMessage`。

每个 `.pb` 是**一条请求的 protobuf 消息体**（`exa.api_server_pb.GetChatMessageRequest`），
**不带 Connect 帧头** —— 用 `fromBinary(schema.requestDesc, bytes)` 直接解，不要走 `deframe`。

原始抓包里这 12 条**全部得到 HTTP 200**。这一条是抓包侧的记录，
**不是这些字节自身能证明的** —— `.pb` 里没有状态码，引用时要说清楚。

## 抹除

`metadata.apiKey` 原本是真实的 `devin-session-token$<JWT>`，已替换成
`devin-session-token$REDACTED-BY-FIXTURE-EXTRACTION`。除此之外字节未经修改。
**提交前请扫一遍 JWT 残留**（base64 编码的 `{"alg":` 头，即 `eyJ` + `hbGciOi`
拼起来那个前缀）。这里故意不写成完整字面量，否则本文件自己就会命中那次扫描。

## `INDEX.json`

每条的形状摘要。汇总（可用 `fromBinary` 复算）：

| | 值 |
|---|---|
| 请求条数 | 12 |
| `chat_model_uid` | kimi-k3-high / swe-1-6-fast / gpt-5-6-terra-high / gemini-3-6-flash-high |
| system prompt 字符数 | 202 / 20945 / 21599 / 21593 |
| `ChatMessagePrompt` 总数 | 135 |
| 带 `thinking` 的回合 | 39 |
| 带 `signature` 的回合 | 2 |
| 带 `images` 的回合 | 11 |
| `source=4`（工具结果）回合 | 23 |
| `tool_calls` 总数 | 23（分布在 17 个回合里，最多的一个回合 2 个） |
| 工具定义 | 11/12 条各 23 个 |
| `configuration.max_tokens` | `128000` × 10、`65535` × 2（**只有 gemini 那两条是 65535**） |

`max_tokens` 是**客户端按模型算出来的**，不是常量 —— 出口不能硬编一个默认值。

## 一个踩过的坑：protobuf 的判空

`geminiThoughtSignature` 是 `bytes`（字段 #17，implicit presence）。它在这 135 个回合里
**从未被设置**，原始字节里连 field #17 的 tag（`0x8A 0x01`）都搜不到。

但用 `(v ?? "") !== ""` 判空会把它算成 **100% 出现** —— 空 `Uint8Array !== ""` 恒真。
本目录第一版 `INDEX.json` 就是这么错的，并且这个假阳性一度被当成「需要处理的新字段」。

**判空只写一处**，`bytes` 按 `length`、数组按 `length`、标量按值：

```ts
const nonEmpty = (v: unknown): boolean =>
  v instanceof Uint8Array ? v.length > 0
  : Array.isArray(v) ? v.length > 0
  : typeof v === "string" ? v.length > 0
  : v !== undefined && v !== null && v !== 0 && v !== 0n && v !== false;
```

## 这些字节能证明什么、不能证明什么

**能**：两万字符量级的 agent 系统提示词 + 23 个工具定义 + 图片 + 工具结果 + 并行工具调用
被上游正常受理。所以「体量或关键词密度触发内容策略分类器」这个说法**不成立**。

**不能**：这里没有任何一条带 Claude Code 身份行的报文，也没有任何一条被拒的样本。
因此「不改身份行会被拒」「改了就够」「上游是按身份行判的」三件事**全都是推断**。
引用这份夹具时不许把它们写成实证 —— 相关取舍见
`src/egress/windsurf/index.ts` 的 `WindsurfSystemIdentityPolicy`。
