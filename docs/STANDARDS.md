# 协议审查基准

审查 `agent-ir` 的 OpenAI 转换时，采用成熟集成实现 OpenCode 的 OpenAI adapter 与其真实
录制样本，而不再保留独立下载的 SDK 或完整 OpenAPI 文档。内容在 Git 忽略的
`docs/standards/`，不会混入网关源码。

## OpenCode OpenAI adapter

- 上游：<https://github.com/anomalyco/opencode>
- 固定提交：`f0afb6750e63ee0a60b052914531bde0afb9bc2b`
- 本地抽取位置：`docs/standards/opencode-openai/`
- 代码基准：Chat 与 Responses adapter、选项映射及对应 provider tests
- 行为基准：Chat 的文本/工具循环流，以及 Responses 的文本/工具循环/图片工具结果/
  reasoning continuation 录制样本
- 核心文件 SHA-256：
  - `src/protocols/openai-chat.ts` — `dd086d7ae33596a876256507dede7f5b9705aafb7cd4502155e9209bfdcc9148`
  - `src/protocols/openai-responses.ts` — `616b4fb54fe5645586b92b584b5d41c6f92f815335205d3efd0fa2f438c64b59`

该基准是交叉实现与录制行为证据，不替代 OpenAI 官方服务端契约。审查时以它来覆盖私有
网关最容易漂移的路径：工具调用与结果关联、SSE delta 聚合、`[DONE]`/终止条件、usage、
reasoning continuation，以及非文本工具结果。
