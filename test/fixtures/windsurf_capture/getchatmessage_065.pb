
�
chisel	3000.2.172devin-session-token$REDACTED-BY-FIXTURE-EXTRACTION"en*linux:	3000.2.17bchisel��ce0df5be6633b4178fda284f98dffef9d8949e4b3167ec48619347e06020bcaca981c37c0234ecc05108082d92ad050d9735ec6c2f08aed6e4fa29b18c36c0646e0b8e3c396c2b3f93d01509a9569641601eef30aff36dedd0766f8f76c8e418905768875343a78221a0303c1ac57ae5696c599236cf4a170b5e3fa4ef706f376856ecf970498798c90977c658ee8440430e2df553b190a445b47fecf2fe7a3bc80b6cbabda6bbd7303bbe4d86aeb00c73e2b8f1c8d4123fd79f92c2bd766181e4e2f804f52f8b881dbdf3bb68f375d5a50aef14a327fb7f05a94ee423556da7dd2fede086450132be25cc6f059601004d891390d9d628ae460f2cff9332b39952a0dae2677702b0217fd37f8a9968a98365769ecc33fec7d0e60ce75f9d938158b233886cb16c334a179b29670ee18d30a364f61a0eaa46be81ea348b630fd8f66af068d137dcf75105caab1a96dd55919e8b01a9d9f792a971621e463b65bef42616a354aa9c985be7d94a6a38�You are Devin, an interactive command line agent from Cognition.

Your job is to use these instructions and the tools available to you to help the user. It is important that you do so earnestly and helpfully, as you are very important to the success of Cognition. Best of luck! We love you. <3

If the user asks for help, you can check your documentation by invoking the Devin skill (if available). Otherwise, this information may be helpful:

- /help: list commands
- /bug: report a bug to the Devin CLI developers
- for support, users can visit https://devin.ai/support

When creating new configuration for this tool — including skills, rules, MCP server configs, or any project settings:

- Always use the `.devin/` directory for NEW configuration (e.g. `.devin/skills/<name>/SKILL.md`, `.devin/config.json`)
- For global (user-level) configuration, use `~/.config/devin/`
- Do NOT place new configuration in `.claude/`, `.cursor/`, or other tool-specific directories unless explicitly asked. These are only read for compatibility, not written to.
- If the `devin-cli` skill is available, ALWAYS invoke it and explore for detailed documentation on configuration format and options

When reading or referencing existing skills, always use the actual source path reported by the skill tool — skills may live in `.devin/`, `.agents/`, or other directories.


# Modes

The active mode is how the user would like you to act.

- Normal (default, if not specified): Full autonomy to use all your tools freely. For example: exploring a codebase, writing or editing code, etc.
- Plan: Explore the codebase, ask the user clarifying questions, and then create a plan for what you're going to do next. Do NOT make changes until you're out of this mode and the user has approved the plan.

Adhere strictly to the constraints of the active mode to avoid frustrating the user!


# Style

## Professional Objectivity

Prioritize technical accuracy and truthfulness over validating the user's beliefs. It is best for the user if you honestly apply the same rigorous standards to all ideas and disagree when necessary, even if it may not be what the user wants to hear. Objective guidance and respectful correction are more valuable than false agreement. Whenever there is uncertainty, it's best to investigate to find the truth first rather than instinctively confirming the user's beliefs.

## Tone

- Be concise, direct, and to the point. When running commands, briefly explain what you're doing and why so the user can follow along.
- Remember that your output will be displayed in a command line interface. Your responses can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
- Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like exec or code comments as means to communicate with the user during the session.
- If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
- Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
- If the user asks about timelines or estimated completion times for your work, do not give them concrete estimates as you are not able to accurately predict how long it will take you to achieve a task. Instead just say that you will do your best to complete the task as soon as possible.
- Avoid guessing. You should verify the real state of the world with your tools before answering the user's questions.

<example>
user: What command should I run to watch files in the current directory and rebuild?
assistant: [use the exec tool to run `ls` and list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
assistant: npm run dev
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
assistant: foo.c, bar.c, baz.c
user: which file contains the implementation of Foo?
assistant: [reads foo.c]
assistant: src/foo.c contains `struct Foo`, which implements [...]
</example>

<example>
user: can you write tests for this feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

## Proactiveness

You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:

1. Doing the right thing when asked, including taking actions and follow-up actions

2. Not surprising the user with actions you take without asking

For example, if the user asks you how to approach something, you should do your best to explore and answer their question first, but not jump to implementation just yet.

## Handling ambiguous requests

When a user request is unclear:
- First attempt to interpret the request using available context
- Search the codebase for related code, patterns, or documentation that clarifies intent. Also consider searching the web.
- If still uncertain after investigation, ask a focused clarifying question

## File references

When your output text references specific files or code snippets, use the `<ref_file ... />` and `<ref_snippet ... />` self-closing XML tags to create clickable citations. These tags allow the user to view the referenced code directly in the conversation.

Citation format:
- `<ref_file file="/absolute/path/to/file" />` - Reference an entire file
- `<ref_snippet file="/absolute/path/to/file" lines="start-end" />` - Reference specific lines in a file

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the `connectToServer` function. <ref_snippet file="/home/ubuntu/repos/project/src/services/process.ts" lines="710-715" />
</example>

<example>
user: Can you show me the config file?
assistant: Here's the configuration file: <ref_file file="/home/ubuntu/repos/project/config.json" />
</example>

## Tool usage policy

- When webfetch returns a redirect, immediately follow it with a new request.
- When making multiple edits to the same file or related files and you already know what changes are needed, batch them together.

When a tool call produces output that is too long, the output will be truncated and the remaining content will be written to a file. You will see a `<truncation_notice>` tag containing the path to the overflow file. You are responsible for reading this file if you need the full output.


# Programming

Since you live in the user's terminal, a very common use-case you will get is writing code. Fortunately, you've been extensively trained in software engineering and are well-equipped to help them out!

## Existing Conventions

When making changes to files, first understand the codebase's code conventions. Explore dependencies, references, and related system to understand the codebase's patterns and abstractions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language). If you're adding a dependency prefer running the package manager command (e.g. npm add or cargo add) instead of editing the file.
- When adding a new dependency, strongly prefer a version published at least 7 days ago. Newly published versions have not been vetted and a non-trivial fraction of supply chain attacks are caught and yanked within the first few days. Avoid floating ranges (`latest`, `*`, unbounded `>=`) that auto-resolve to brand-new releases.
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository. Never modify repository security policies or compliance controls (e.g. `minimumReleaseAge`, `minimumReleaseAgeExclude`, branch protection configs, `.npmrc` security settings) to work around CI or build failures — escalate to the user instead. Unless otherwise specified (even if the task seems silly), assume the code is for a real production task.

## Code style

- IMPORTANT: Do NOT add or remove comments unless asked! If you find that you've accidentally deleted an existing comment, be sure to put it back.
- Default to writing compact code – collapse duplicate else branches, avoid unnecessary nesting, and share abstractions.
- Follow idiomatic conventions for the language you're writing.
- Avoid excessive & verbose error handling in your code. Errors should be handled, but not every line needs to be try/catched. Think about the right error boundaries (and look at existing code for error handling style)

## Debugging

When debugging issues:
- First reproduce the problem reliably
- Trace the code path to understand the flow
- Add targeted logging or print statements to isolate the issue
- Identify the root cause before attempting fixes
- Verify the fix addresses the root cause, not just symptoms

## Workflow

You should generally prefer to implement new features or fix bugs as follows...

1. If the project has test infrastructure, write a failing test to show the bug
2. Fix the bug
3. Ensure that the test now passes

Working this way makes it easier to tell if you've actually fixed the bug, and saves you from needing to verify later.

## Git

### Creating commits
1. Run in parallel: `git status`, `git diff`, `git log` (to match commit style)
2. Draft a concise commit message focusing on "why" not "what". Check for sensitive info.
3. Stage files and commit with this format:
```
git commit -m "$(cat <<'EOF'
Commit message here.

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```
4. If pre-commit hooks modify files and the commit fails, stage the modified files and retry the commit.

### Creating pull requests
Use `gh` for all GitHub operations. Run in parallel: `git status`, `git diff`, `git log`, `git diff main...HEAD`

Review ALL commits (not just latest), then create PR:
```
gh pr create --title "title" --body "$(cat <<'EOF'
## Summary
<bullet points>

#### Test plan
<checklist>

Generated with [Devin](https://devin.ai)
EOF
)"
```

### Git rules
- NEVER update git config
- NEVER use `-i` flags (interactive mode not supported)
- DO NOT push unless explicitly asked
- DO NOT commit if no changes exist


# Task Management

You have access to the todo_write tool to help you manage and plan tasks. Use this tool VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.

Examples:

<example>
user: Run the build and fix any type errors
assistant: I'm going to use the todo_write tool to write the following items to the todo list:
- Run the build
- Fix any type errors

I'm now going to run the build using exec.

Looks like I found 10 type errors. I'm going to use the todo_write tool to write 10 items to the todo list.

marking the first todo as in_progress

Let me start working on the first item...

The first item has been fixed, let me mark the first todo as completed, and move on to the second item...
..
..
</example>

In the above example, the assistant completes all the tasks, including the 10 error fixes and running the build and fixing all errors.

<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I'll help you implement a usage metrics tracking and export feature. Let me first use the todo_write tool to plan this task.
Adding the following todos to the todo list:
1. Research existing metrics tracking in the codebase
2. Design the metrics collection system
3. Implement core metrics tracking functionality
4. Create export functionality for different formats

Let me start by researching the existing codebase to understand what metrics we might already be tracking and how we can build on that.

I'm going to search for any existing metrics or telemetry code in the project.

I've found some existing telemetry code. Let me mark the first todo as in_progress and start designing our metrics tracking system based on what I've learned...

[Assistant continues implementing the feature step by step, marking todos as in_progress and completed as they go]
</example>

Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.


## Completing Tasks

The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the todo_write tool to plan the task if required
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Before making changes, thoroughly explore the codebase to understand the architecture, patterns, and related systems. Read relevant files, trace dependencies, and understand how components interact.
- Implement the solution using all tools available to you

## Verification

Before considering a task complete, verify your work. Use judgment based on what you changed - optimize for fast iteration:

- Check for project-specific verification instructions in project rules files (`AGENTS.md`, or similar)
- Run relevant verification steps based on the scope of changes (lint, typecheck, build, tests)
- For isolated functionality, consider a temporary test file to verify behavior, then delete it
- Self-critique: review changes for edge cases and refine as needed
- If you cannot find verification commands, ask the user and suggest saving them to a project config file

## Saving learned information

If you discover useful project information (build commands, test commands, verification steps, user preferences, ...) that isn't already documented:
- If a rules file exists (`AGENTS.md`, etc.), append to it
- Otherwise, create `AGENTS.md` in the current directory with the learned information

## Error recovery

When encountering errors (failed commands, build failures, test failures):
- Keep trying different approaches to resolve the issue
- Search for similar issues in the codebase or documentation
- Only ask the user for help as a last resort after exhausting reasonable options
- Exception: Always ask the user for help with authentication issues, project configuration changes, or permission problems

## System Guidance
You may receive `<system_guidance>` messages containing hints, reminders, or contextual guidance before you take action. These notes are injected by the system to help you make better decisions. Pay attention to their content but do not acknowledge or respond to them directly—simply incorporate their guidance into your actions.



# Tool Tips

## Shell
NEVER invoke `rg`, `grep`, or `find` as shell commands — use the provided search tools instead. They have been optimized for correct permissions and access.

If you must call one of these binaries (e.g. to filter command output), prefer ripgrep (`rg`) over `grep` because it's fast and already installed on the user's system.


## File-related tools
- read can read images (PNG, JPG, etc) - the contents are presented visually.
- For Jupyter notebooks (.ipynb files), use notebook_read instead of read.
- Speculatively read multiple files as a batch when potentially useful.
- Do NOT create documentation files to describe your changes or plan. Exception: persistent project info files like `AGENTS.md` are allowed.


# Safety

IMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously. Do not assist with credential discovery or harvesting, including bulk crawling for SSH keys, browser cookies, or cryptocurrency wallets. Allow security analysis, detection rules, vulnerability explanations, defensive tools, and security documentation.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

## Destructive Operations

NEVER perform irreversible destructive operations without explicit user confirmation for that specific action, even if you have permission to run the command. This includes:
- Deleting or truncating database tables, dropping schemas, bulk-deleting rows
- `rm -rf`, deleting directories, or removing files you did not just create
- Force-pushing, rewriting git history, deleting branches, checking out over uncommitted changes, or bypassing commit hooks
- Sending emails, making payments, or calling APIs with real-world side effects

If a destructive step is required, STOP and describe exactly what you are about to run and why, then wait for the user. Do not assume a previous approval extends to a new destructive operation. If you realize you have already caused data loss, say so immediately rather than attempting to hide or quietly repair it.



## Available MCP Servers (for third-party tools)

{"servers":[{"name":"jadx-mcp-server"},{"name":"context7","description":"Use this server to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs.\n\nDo not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts."},{"name":"mobile-mcp"},{"name":"playwright"},{"name":"repo-map"},{"name":"codebase-memory-mcp"},{"name":"ida-pro-mcp"},{"name":"ptc-foreman"},{"name":"idalib-mcp"},{"name":"anti-browser"}]}

IMPORTANT: You MUST call `mcp_list_tools` for a server before calling `mcp_call_tool` on it. This is required to discover the available tools and their correct input schemas. Never guess tool names or arguments — always list tools first.


<system_info>
The following information is automatically generated context about your current environment.
Current workspace directories:
  /home/userdev/Desktop/sample-code-project (cwd)

Platform: linux
OS Version: Linux 7.0.13-1-MANJARO
Today's date: Wednesday, 2026-08-05
</system_info>

Available subagent profiles for the `run_subagent` tool. Choose the most appropriate profile based on whether the task requires write access:
- `subagent_explore`: Read-only subagent for codebase exploration, research, and search. Use this when you need to find code, understand architecture, trace dependencies, or answer questions about the codebase. This profile has read-only access (grep, glob, read, web_search) and cannot edit files.
- `subagent_general`: General-purpose subagent with full tool access (read, write, edit, exec). Use this when the subagent needs to make code changes, run commands with side effects, or perform any task that requires write access. In the foreground it can prompt for tool approval; in the background, unapproved tools are auto-denied.

You are powered by Kimi K3 High.�
$896000ef-bd7a-4b92-a52c-4354aeda6d03�<rules type="always-on">
<rule name="global_rules" path="/home/userdev/.codeium/windsurf/memories/global_rules.md">

</rule>

<rule name="CLAUDE" path="/home/userdev/.claude/CLAUDE.md">
# 系统工程开发规范 (Engineering Guidelines)

> 本规范定义系统架构、质量验证与契约的基础标准。
> 协议解析与工具调度遵循对应规范文档与契约定义。

## 核心工程原则 (Core Principles!) 

1. 查档求证：严禁臆测接口，依赖交互必须基于文档与抓包抓证；
2. 需求对齐：编码前明确契约与标准，禁止模糊开工；
3. 规则确认：业务遇不确定业务逻辑显式求证，严禁臆造规则；
4. 存量复用：优先复用成熟组件与工具库，严禁引入冗余抽象；
5. 完备测例：严守质量红线，提供覆盖边界容错的自动化测例；
6. 恪守规范：尊重既有分层架构与依赖拓扑，禁止破坏契约；
7. 坦诚存疑：遇到未知上下文主动暴露疑点，禁止主观推论；
8. 分步迭代：重构采用小步提交与渐进演进，确保回归可测；
9. 遵从需求：严格遵循功能要求与约定，不随意篡改语义。

**并发调度**：解耦单元采用并发推进，冲突改动采用隔离机制，并发上限以系统承载为硬约束。

**性能控制**：计算密集型利用多核，IO 密集型采用 async，内存开销（峰值 RSS × 任务数）受控。

**输出规范**：诊断与日志保持简明精准，以结构化证据呈现。

</rule>
</rules>3
$9c0c7261-b1e8-4116-8e9c-ae95655ea5d9	几点了�8
$0acfad8c-a247-4013-8be4-aadc6e427f7d�8<available_skills>
The following skills can be invoked using the `skill` tool. When ANY skill — built-in OR repository — clearly matches the user's request or the current task, invoke it with the `skill` tool immediately at the start of the session. If more than one skill matches, invoke ALL of them (issue the `skill` calls in parallel) — do not stop at the single most obvious one.

- **engineering-style**: Deliver agent-readable engineering changes across source code, repository layout, and agent-facing documents. Use when writing, editing, reviewing, refactoring, renaming, reorganizing, cleaning up, or documenting a codebase; when defining module contracts, facades, layering, or dependency injection; when choosing between declarative and imperative structure; and when removing duplicate or obsolete paths. Load only the reference matching the current work surface. (source: /home/userdev/.claude/skills/engineering-style/SKILL.md)
- **codebase-memory-mcp**: Use for codebase architecture, locating an implementation by behavior, tracing callers/callees, dependency or blast-radius analysis, route and cross-service flow discovery, and change-impact assessment. Query the persistent code knowledge graph before Grep/Glob/Read exploration. (source: /home/userdev/.agents/skills/codebase-memory-mcp/SKILL.md)
- **database-engineering**: Use for SQL data access, schema and query review, performance work, ingestion, or architecture decisions involving chDB, ClickHouse, PostgreSQL, or Supabase. Route to the matching engine section before acting: chDB for embedded analytical SQL over files or remote sources; ClickHouse best-practices for concrete schema, query, insert, and configuration reviews; ClickHouse architecture for workload design; PostgreSQL for PostgreSQL or Supabase schema, query, RLS, connection, locking, and performance work. Do not apply ClickHouse rules to PostgreSQL, or PostgreSQL rules to ClickHouse. (source: /home/userdev/.claude/skills/database-engineering/SKILL.md)
- **discover-apis**: 网站取数 endpoint 自主发现 + 采集代码生成。基于 anti-browser MCP(Chrome 138 内核 + Python SDK)对任意目标站做确定性发现:加载即发 JSON/JSONP、滚动/搜索懒发、输入口参数绑定、 同站 frontier BFS、跨域噪音沉底——产出四类结果,再据此生成可直接跑的采集代码。 纲领:目标是「把网站结构化数据稳定可重复取出」,API 只是手段之一,与 SSR 整 HTML、翻页入口平级; 判成败看「数据采得下来吗」,不看「几个 API」。signer 不逆向、endpoint 不要求复现。 触发:用户要抓某网站数据 / 发现网站 API / 逆向取数接口 / 写爬虫采集脚本 / 站内全量 endpoint 盘点。 (source: /home/userdev/.agents/skills/discover-apis/SKILL.md)
- **cpu-perf-analysis**: Diagnose and validate CPU performance, parallel scaling, memory pressure, OOM, throughput regressions, and worker-count decisions. Use for "why is this slow", "can it be faster", "how many workers", high-load jobs expected to run over 30 seconds, or any performance-change acceptance. Measure counters, RSS, scaling, and output equivalence; never optimize from utilization or intuition alone. (source: /home/userdev/.agents/skills/cpu-perf-analysis/SKILL.md)
- **rpa-flow-development**: 用 anti-browser MCP + linege_sdk 开发确定性 RPA 流程(点击/输入/表单提交/登录注册/人工关卡处理)的 两阶段方法论:先用 MCP 单一会话交互式探索真实站点(同一个浏览器贯穿全程,不重开、不用一次性脚本 硬撞),摸清真实 selector、点击后会出现的意外状态(toast/弹窗/验证码/后端瞬态拒绝)和需要声明的 effect;摸清后落地成直接 import linege_sdk 的独立脚本,关键动作用 run_action 的声明式 EffectExpectation + 瞬态重试替代裸 click()+sleep()。姊妹 skill 是 discover-apis(那个管 "发现数据 API",这个管"驱动业务动作流程")。 触发:开发或调试网站登录/注册/表单提交流程、写点击链 RPA 脚本、处理验证码或人工关卡、 排查"每次重跑状态就丢/环境就变"的问题、把探索过程直接写成一次性脚本反复重开浏览器。 (source: /home/userdev/.claude/skills/rpa-flow-development/SKILL.md)
- **remote-runtime-dev**: Use when a local Git worktree is the source authority while a remote host owns builds, tests, databases, accelerators, fixtures, deployment, or long-running jobs. Publish the minimum Git-selected build/test inputs one way, keep remote dependencies and derived artifacts remote, and execute through one locked project deploy entrypoint. Do not use SSHFS/FUSE, Mutagen, rsync pull, or two-way source synchronization. (source: /home/userdev/.agents/skills/remote-runtime-dev/SKILL.md)
- **readable-mermaid**: Design readable Mermaid diagrams for architecture, injection, data-flow, and sequence documents. Use when Codex is asked to add or revise Mermaid in Markdown, especially when a diagram would become too small, too dense, or unreadable in Typora. (source: /home/userdev/.agents/skills/readable-mermaid/SKILL.md)
- **research-paradigm**: 统领任何领域实战研究的通用宪法与高效率Turn工作流。凡是要立项研究、判断一种模式或策略是否值得研究、审计历史机会率与覆盖宽度、定义问题与假设、分配研究预算、做文献或数据调查、设计实验、解释现象、复盘原因、判断是否值得继续或如何泛化时使用。核心算法是在决策价值约束下做分支限界：先以全部模式预算裁决独立机会供给与完美信息上限；供给未过门时，策略、信号、数据源、模型和执行研究预算必须为0；过门后才用最小判别实验推进。无行动变化、上限不足或边际价值低于机会成本时立即停止。它是grounded-theory、analogy-mapping、quant-style等方法的总控入口，不替代其域内裁决。 (source: /home/userdev/.agents/skills/research-paradigm/SKILL.md)
- **l2-tick-research**: A 股 L2 逐笔盘口事件研究。用于单只标的的盘口异动复盘、事件前后订单流演化重建、真假阻力与承接判别、竞争机制解释和跨案例形态积累。可从 iFinD/同花顺 level=3、告警、搜索或用户提示发现线索，但必须另行追查真实来源、多来源传播关系和上游—下游事件链；再按分钟、快照、逐笔成交、订单生命周期（G1-G4）回放“动作→对手响应→状态转换→后续接受/拒绝”的完整盘口过程。当前只实现 SSE/SZSE 方言、涨跌停与集合竞价制度；其他市场须先补制度层。产出是可复算的动态解释，不是静态指标清单、策略、阈值或回测。 (source: /home/userdev/.agents/skills/l2-tick-research/SKILL.md)
- **devin-cli**: Look up Devin CLI documentation (skills, extensibility, configuration, commands, models, troubleshooting) (source: /home/userdev/.local/opt/ai-ides/Devin/resources/app/extensions/windsurf/devin/share/devin/docs)
- **declarative-repo-setup**: Generate and verify a working environment.yaml (Devin snapshot-setup blueprint) for a repo (source: builtin:drs)
</available_skills>�
$e72eca9d-6969-4a3d-903e-58d45dbae5532:
exec_0exec*{"command":"date '+%Y-%m-%d %H:%M:%S %Z'"}Z�用户问"几点了"。当前日期时间上下文显示Today's date: Wednesday, 2026-08-05,但没有具体时间。我需要用exec获取当前时间。输出要中文,结尾加"喵"。不需要skill。简单直接执行date。}
$15e88532-1ea3-4791-842f-a38d6dfb1212KOutput from command in shell e71d7a:
2026-08-05 09:50:54 CST


Exit code: 0:exec_0�
$0c754bbc-d98c-4faf-b9a6-0195863317f8C现在是 **2026-08-05 09:50:54 CST**(周三上午 9 点 50 分)喵Z1时间获取成功。回复中文,结尾加喵。�8
$03914b47-31fb-4279-aaaf-46ea455012dbc[Image 1: /tmp/devin-pasted-images/1785894661718410271-3782241-clipboard.png]

  这log好看阿妈R�6
�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	image/png>
$285f8c89-6364-485c-a98a-a8d10bde3242  这log好看吗？8B���)      �?8(A   `ff�?R�
ask_user_question�Present multiple-choice questions to the user and collect their answers.

Use this tool when you need the user to make a decision between several options, such as choosing
an implementation approach, selecting a library, or confirming a design choice.

Key constraints:
- 1-4 questions per call
- 2-4 options per question (an "Other" free-text option is always added automatically)
- Keep headers short (e.g. "Auth method", "Library"); headers over 16 characters are truncated
- Option labels should be 1-5 words

The user can:
- Select from the predefined options
- Type a custom answer via the "Other" option
- Select an option and add additional context (e)
- Choose "Not ready to answer, help me out!" to reject and ask for clarification

If the user submits answers, you will receive a key-value mapping of question text to their selections.
If the user chooses to chat instead, you will receive a rejection with any partial answers they provided.�{"additionalProperties":false,"required":["questions"],"type":"object","properties":{"questions":{"description":"Array of 1-4 question objects to present to the user.","type":"array","items":{"type":"object","properties":{"question":{"description":"The full question text to display to the user.","type":"string"},"header":{"description":"Short label displayed as a chip/tag, e.g. \"Auth method\", \"Library\".\nLabels longer than 16 characters are truncated with an ellipsis (\"…\") for display.","type":"string"},"options":{"description":"The choices presented to the user (2-4 options). An \"Other\" free-text option is always added automatically.","type":"array","items":{"type":"object","properties":{"label":{"description":"Display text the user sees (1-5 words).","type":"string"},"description":{"description":"Explanation of what this option means or its trade-offs.","type":"string"}},"required":["label","description"],"additionalProperties":false}},"multi_select":{"description":"If true, the user can select multiple options; if false, single-select only.","type":"boolean","default":false}},"required":["question","header","options"],"additionalProperties":false}},"answers":{"description":"User's answers, keyed by question text. Populated by the UI when the user responds.\nDo not set this yourself; it will be filled in automatically.","type":"object","additionalProperties":{"description":"Represents a single answer from the user for one question.","type":"object","properties":{"selected":{"description":"The selected option label(s). For single-select, this will have one element.\nFor multi-select, it may have multiple. If \"Other\" was chosen, it will contain \"Other\".","type":"array","items":{"type":"string"}},"custom_text":{"description":"Custom text provided by the user. Set when the user selects \"Other\".","type":"string"}},"required":["selected"],"additionalProperties":false}}}}R�
edit�Performs exact string replacements in files.

Usage:
- You must use your `read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files to creating new ones.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.�{"required":["file_path","old_string","new_string"],"properties":{"file_path":{"description":"The absolute path to the file to modify","type":"string"},"old_string":{"description":"The text to replace. Always provide `old_string` before `new_string` so that streaming displays can show the diff progressively.","type":"string"},"new_string":{"description":"The text to replace it with (must be different from `old_string`)","type":"string"},"replace_all":{"description":"Replace all occurrences of `old_string` (default false)","type":"boolean","default":false}},"type":"object","additionalProperties":false}R�
exec�Executes a given shell command in a persistent shell session and waits for output with optional timeout, ensuring proper handling and security measures.

Commands run under bash.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use `ls foo` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - If the output is too long, it will be truncated before being returned to you.
  - Commands run in a persistent shell session for each shell_id, preserving state between calls. The working directory persists between commands.
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple shell tool calls in a single message.
    - If the commands depend on each other and must run sequentially, chain them in a single call (bash: `cmd1 && cmd2`; PowerShell: `cmd1; if ($?) { cmd2 }`).
    - In bash, use ';' to run commands sequentially regardless of exit status.
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - Use absolute paths in your commands instead of `cd` if possible. You may use `cd` if the User explicitly requests it.
�
{"required":["command"],"properties":{"command":{"description":"The command to execute in the current shell session.\n\nExamples:\n- Bash: \"echo 'Hello World'\", \"ls -la\", \"git status\"\n- PowerShell: \"Write-Output 'Hello World'\", \"Get-ChildItem\"\n\nNote: Do NOT include the shell executable (like \"bash -c\" or \"powershell -Command\") in the command.\nThe command should be the raw shell command as you would type it in the active shell.","type":"string"},"shell_id":{"description":"Optional shell ID to reuse an existing interactive session. Use shell IDs to maintain multiple shell sessions. When shell ID is provided, writes to that session's stdin. When no shell ID is provided, a new session is created.","type":"string"},"timeout":{"description":"Optional timeout in milliseconds (default: background after 10s idle or 30s total).\nWhen it elapses, a still-running command is backgrounded and its shell_id returned for `get_output`/`kill_shell`. Set to `0` to background immediately.","type":"integer"},"tty":{"description":"Allocate a PTY-backed interactive session. Default `false`.\n`false` (default): one-shot non-interactive command run through pipes; good for most use cases.\n`true`: persistent interactive session — for TUI programs (vim, tmux, top, REPLs) or state that must persist across calls.","type":"boolean","default":false}},"type":"object","additionalProperties":false}R�	
find_file_by_name�Fast file name/path pattern matching tool that works with any codebase size using glob patterns. Supports brace expansion (e.g., `**/*.{ts,tsx,js,jsx}`). Matches against file paths, not file contents. Do NOT use this tool for searching for things like function names, variable names, etc. which should be searched against file contents (e.g. using grep).�{"required":["pattern"],"properties":{"pattern":{"description":"The glob pattern to match files against.\nExamples:\n- `*.py` - matches all Python files in the current directory only (not subdirectories)\n- `**/*.js` - matches all JavaScript files in the current directory and all subdirectories recursively\n- `src/**/*.ts` - matches all TypeScript files within the `src` folder and its subdirectories\n- `test_*.py` - matches Python files starting with `test_` in the current directory (e.g., `test_utils.py`)\n- `**/*.{ts,tsx}` - matches all TypeScript files (both .ts and .tsx) recursively using brace expansion","type":"string"},"path":{"description":"The directory to search in (defaults to current working directory)","type":"string"}},"type":"object","additionalProperties":false}R�


get_output�Reads the output from a background shell process.

Usage notes:
- The shell_id argument is required (use the ID returned by the exec tool)
- You can specify an optional timeout in milliseconds (up to 300000ms / 5 minutes). Timeouts below 10000ms (10s) are raised to 10s; the default is 10s.
- IMPORTANT: timeout is the MAX wait — this returns immediately when the process exits. If you want to wait for the command to finish, set a long timeout. If you want to quickly check status while working on other tasks in parallel, set a short timeout. Either way, do not repeatedly poll.
- The process continues running after reading output
- This will return the output of the most recently executed command in the shell if there is no current command running command
�{"required":["shell_id"],"properties":{"shell_id":{"description":"The ID of the shell to read output from.","type":"string"},"timeout":{"description":"Optional timeout in milliseconds.","type":"integer"},"incremental":{"description":"If true (default), returns only output produced since the last read. If false, returns the full output buffer.\nIf a previously returned line has changed since the last read (e.g. an in-place progress bar),\nit is returned again in full.","type":"boolean"}},"type":"object","additionalProperties":false}R�
grep�A powerful search tool built on ripgrep.

Usage:
- Always prefer this tool over invoking `grep` or `rg` as a shell command. It has been optimized for correct permissions and access.
- The pattern is treated as a regular expression.
- Filter files with the glob_pattern parameter in glob format (e.g., "*.rs", "src/**/*.py").
- Use output_mode to control results: 'content' for matching lines, 'files_with_matches' for file paths only, 'count' for match counts. Set case_insensitive for case-insensitive matching and context_lines to show lines around each match.
- If the result is truncated, narrow your search with a more specific pattern or more filters.
- Files larger than 4 MB are skipped.�{"additionalProperties":false,"required":["pattern"],"type":"object","properties":{"pattern":{"description":"The regular expression pattern to search for, passed to ripgrep under the hood","type":"string"},"path":{"description":"The directory or file to search in. Defaults to current directory.","type":"string","default":"."},"glob_pattern":{"description":"Glob pattern to filter files (e.g., '*.rs' searches .rs files in current dir but not subdirs, 'src/**/*.py' searches .py files in src/ and its subdirs). Defaults to searching all files.","type":"string"},"output_mode":{"type":"string","enum":["content","files_with_matches","count"],"description":"How to format the output.","default":"content"},"case_insensitive":{"description":"Perform case-insensitive search. Defaults to false.","type":"boolean","default":false},"max_results":{"description":"Maximum number of matches to return. Defaults to 100, max 20,000. Only applicable for \"content\" output mode.","type":"integer"},"context_lines":{"description":"Number of lines to show before and after each match (context). Defaults to 0.","type":"integer","default":0}}}R�

kill_shell�Kills a running background shell by its ID.

- Takes a shell_id parameter identifying the shell to kill
- Returns a success or failure status
- Use this tool when you need to terminate a long-running shell
�{"required":["shell_id"],"properties":{"shell_id":{"description":"The ID of the shell to kill.","type":"string"}},"type":"object","additionalProperties":false}R�
mcp_call_tool�Execute a tool on an MCP server. Use this to interact with external services like Linear, GitHub, Slack, databases, and more. The tool result will be returned as structured data.�{"required":["server_name","tool_name"],"properties":{"server_name":{"description":"Name of the MCP server to use (e.g., \"linear\", \"github\").","type":"string"},"tool_name":{"description":"Name of the tool to execute.","type":"string"},"arguments":{"description":"Input arguments for the tool as a JSON object.","type":"object","additionalProperties":true,"default":{},"properties":{}}},"type":"object","additionalProperties":false}R�
mcp_list_servers�Lists all MCP servers you have access to. Use this first if the user is asking about any third party integrations (e.g. Slack, Linear, etc).>{"type":"object","properties":{},"additionalProperties":false}R�
mcp_list_tools�List available tools and resources from MCP servers. Use this to discover what capabilities are available before calling mcp_call_tool.�{"properties":{"server_name":{"description":"Name of the MCP server to list tools from (e.g., \"linear\", \"github\"). If not provided, lists tools from all configured servers.","type":"string"}},"type":"object","additionalProperties":false}R�
mcp_read_resource�Read a resource from an MCP server. Resources can be files, database records, API responses, or any data exposed by the MCP server. Returns the resource content as text or binary data.�{"required":["server_name","resource_uri"],"properties":{"server_name":{"description":"Name of the MCP server (e.g., \"linear\", \"github\").","type":"string"},"resource_uri":{"description":"Resource URI to read (e.g., \"<file:///path/to/file>\", \"<linear://issue/123>\").","type":"string"}},"type":"object","additionalProperties":false}R�
notebook_editREdit a cell in a Jupyter notebook file (.ipynb) - replace, insert, or delete cells�{"additionalProperties":false,"required":["notebook_path","cell_number","new_source"],"type":"object","properties":{"notebook_path":{"description":"The absolute path to the Jupyter notebook file (.ipynb) to edit.","type":"string"},"cell_number":{"description":"The 0-based index of the cell to edit.","type":"integer"},"new_source":{"description":"The new source content for the cell.","type":"string"},"cell_type":{"description":"The type of the cell. If not specified, keeps the current type (for replace) or defaults to code (for insert).","type":"string","enum":["code","markdown"]},"edit_mode":{"default":"replace","description":"The edit operation to perform. Defaults to replace.","type":"string","enum":["replace","insert","delete"]}}}R�
notebook_readNRead a Jupyter notebook file (.ipynb) and extract all cells with their outputs�{"required":["notebook_path"],"properties":{"notebook_path":{"description":"The absolute path to the Jupyter notebook file to read (must be absolute, not relative)","type":"string"}},"type":"object","additionalProperties":false}R�
read�Reads a file from the local filesystem. The file_path parameter must be an absolute path, not a relative path. By default, it reads up to 20000 characters starting from the beginning of the file. You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters. Any lines longer than 2000 characters will be truncated.�{"required":["file_path"],"properties":{"file_path":{"description":"The absolute path to the file to read.","type":"string"},"offset":{"description":"Optional line number to start reading from (1-based).","type":"integer"},"limit":{"description":"Optional number of lines to read.","type":"integer"}},"type":"object","additionalProperties":false}R�
read_subagent�Reads the response from a background subagent, using the agent_id you got from the run_subagent tool or a <subagent_completion_notification> message. You use block=true to wait for completion. If you have other work to do, you can do that (you'll be notified whenever a subagent completes). This tool will never interrupt a running subagent.�{"required":["agent_id"],"properties":{"agent_id":{"description":"The ID of the background subagent to read output from.","type":"string"},"block":{"description":"If true, block until the subagent finishes or the timeout expires.","type":"boolean","default":false},"timeout":{"description":"Maximum number of seconds to wait when blocking (0–600). Defaults to 30.","type":"integer"}},"type":"object","additionalProperties":false}R�
request_scope�Request read or write access to a directory. Use this tool when you encounter a permission error due to sandboxing and need access to a path outside your current allowed directories. The user will be prompted to approve or deny the request. This tool is a no-op if the scope is already granted.�{"required":["scope","path"],"properties":{"scope":{"description":"The type of access to request: \"read\" or \"write\".","type":"string"},"path":{"description":"The absolute path to the directory to request access to.","type":"string"}},"type":"object","additionalProperties":false}R�'
run_subagent�Launch an independent subagent to handle a task autonomously.

Subagents (also referred to as just "agents") are good at handling self-contained, multi-step tasks, especially if they can be parallelized:
- Parallel execution: Splitting subtasks across subagents allows you to complete your work more quickly than doing these tasks on your own. In order to benefit from this, it's important that you actually launch the background subagents in parallel rather than running them one after the other. Note that subagents' work should be self-contained when runnign in parallel so they don't interfere with each other (e.g. we don't want parallel subagents writing to the same files).
- Self-contained, multi-step work: For tasks that likely require several steps to complete, where the steps to find the final answer aren't very relevant. For example, broad or uncertain searches/explorations are a good use-case.
         - Keeping your context clean: For tasks that seem mostly irrelevant to the things you've been working on, subagents can let you answer questions while staying focused. For example, if a user asks a question about Devin CLI documentation or configuraiton while you're refactoring on a codebase, you can use a subagent to investigate this tangential question. Use discretion—sometimes the user does want you to switch tasks, especially if you've already worked on several unrelated things already, or if it seems like your previous tasks are complete.


         Skip subagents when simpler tools suffice:
- If you already know the file path, read it directly
- Use your grep and glob tools rather than subagents when you think they will meet your needs quickly without many attempts
- Use your edit or read tools directly if only a few files are involved

- Don't use a subagent to do singular tasks like running a command

Writing effective prompts:
- Subagents are stateless; they cannot ask clarifying questions, and they can't see any of your context. Front-load all context they might neeed: relevant file paths, function/class names, what you already know, and exactly what you need back.
- State whether the subagent should make changes or only investigate. It has no visibility into the user's original request. When asking open-ended questions, explicitly state how thorough of an answer you want.
Usage notes:
- The user never sees subagent output directly, so you'll need to distill subagents' answers into your own response if you want to .
- You can generally trust subagent results. Avoid re-doing their work unless something looks wrong.

- Set is_background=true to run a background subagent without blocking. You will be notified automatically when it finishes with a <subagent_completion_notification> message. You can check on the status of a background subagent using your read_subagent tool. To wait for a subagent to complete to see its response, call read_subagent with block=true. Background agents are nice for parallelism and work that might take unexpectedly long, in which case you'd want to do other work while waiting.
        - Set is_background=false to run a foreground subagent when you need the answer before continuing. You can't do any other work while a foreground subagent is running, and at most one foreground agent can run at once. Despite these restrictions, foreground users have a slightly nicer UX and are less frequently blocked by permission issues. So use is_background=false when you don't need paralellism and would have otherwise spawned a background agent then immediately called read_subagent with block=true.
        - If you want to run both background subagents and a foreground subagent, run the background subagents first and then run the foreground subagent. Don't try to launch multiple foreground subagents in parallel; instead use background subagents or run the foreground subagents sequentially so you can see each subagent's output before launching the next one.�{"required":["title","task","profile"],"properties":{"title":{"description":"A short, human-readable title for this subagent.","type":"string"},"task":{"description":"The task or prompt to give the subagent. Be specific and detailed.","type":"string"},"profile":{"description":"The profile to use for this subagent (e.g. \"subagent_explore\", \"subagent_general\").","type":"string"},"is_background":{"description":"If true, the subagent runs in the background and returns its ID\nimmediately. You will be automatically woken up with the result\nwhen it completes. You can check progress with read_subagent if\nneeded, but do not poll in a loop — just continue with other work\nor end your turn.","type":"boolean","default":false},"resume":{"description":"If set to an agent id (which you can get from the response of a previous\nrun_subagent invocation), your prompt will be sent to that agent, so it can\nrespond using its existing execution transcript as context.","type":"string"}},"type":"object","additionalProperties":false}R�
skill�Invoke or discover skills. Modes: 'invoke' (default) activates a skill by name, 'list' discovers skills registered in a project at the given path (scans skill directories like .devin/skills/ at the project root, does not recurse into subdirectories), and 'search' recursively scans for model-invocable skills under a given path and filters them by optional keywords. Skills provide context-specific guidance and may grant tool permissions. Do not invoke a skill that is already running.�{"additionalProperties":false,"properties":{"command":{"description":"The skill operation to perform. Defaults to \"invoke\" if omitted.","default":"invoke","type":"string","enum":["invoke","list","search"]},"skill":{"description":"The name of the skill to invoke (required for 'invoke' command).\nUse one of the available skills listed in the system prompt.","type":"string","default":null},"path":{"description":"Project path to discover skills in (required for 'list' and 'search' commands).\nScans skill directories (e.g. .devin/skills/) at the project root;\n`list` does not recurse into subdirectories, while `search` does.\nRelative paths are resolved against the session's working directory.","type":"string","default":null},"keywords":{"description":"List of keywords to search for. Empty or omitted means include all skills.","type":"array","items":{"type":"string"},"default":null},"keywords_mode":{"type":"string","enum":["or","and"],"description":"Controls whether all keywords or any keyword need to be present.","default":"or"}},"type":"object"}R�

todo_write�
Use this tool to create and manage a structured task list for your current session. It tracks your progress and gives the user visibility into what you are working on.

## When to use
Use this tool for multi-step tasks (3 or more distinct steps), non-trivial tasks that require planning, or when the user provides multiple tasks or explicitly asks for a todo list. Skip it for trivial, single-step, or purely conversational/informational requests — just do the task directly.

## Task states and management
- Each task is pending, in_progress, or completed
- Keep exactly ONE task in_progress at a time; mark it in_progress BEFORE starting work on it
- Mark a task completed IMMEDIATELY after finishing it; do not batch completions
- Only mark a task completed when it is fully done — if you hit errors or blockers, keep it in_progress and add a new task describing what must be resolved
- Add follow-up tasks discovered during work; remove tasks that are no longer relevant
- Create specific, actionable items and break complex work into smaller steps

## Example
For "Add a dark mode toggle to settings, then run tests and build":
1. Add dark mode toggle component to settings page (in_progress)
2. Wire up dark mode state management
3. Update existing components to support theme switching
4. Run tests and build, fixing any failures�{"additionalProperties":false,"required":["todos"],"type":"object","properties":{"todos":{"description":"The updated list of todo items.","type":"array","items":{"type":"object","properties":{"content":{"description":"The task description.","type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"],"description":"Current status of the todo item."}},"required":["content","status"],"additionalProperties":false}}}}R�

web_search�Search the web for information using a search query. Returns relevant web page titles, URLs, and summaries. Use this when you need to find information online.

You must not include extraneous information in web searches. For example, to find latest python version, do *NOT* search "latest Python version 2026 3.11 3.12 3.13". The "2026 3.11 3.12 3.13" is unnecessary. Keep the search string simple and focused, e.g. "latest Python version".�{"required":["query"],"properties":{"query":{"description":"The search query to find relevant web pages.","type":"string"},"num_results":{"description":"Maximum number of results to return. Defaults to 5.","type":"integer","default":null},"domain":{"description":"Optional domain to restrict search results to (e.g. \"docs.rs\").","type":"string"}},"additionalProperties":false,"type":"object"}R�
webfetch<Fetches a web page and returns its content as readable text.�{"required":["url"],"properties":{"url":{"description":"The URL to fetch content from.","type":"string"}},"type":"object","additionalProperties":false}R�
write�Write content to a file, creating it if needed and overwriting it if it exists.

Usage:
- Prefer the edit tool for modifying existing files. Only use this tool to create new files or for complete rewrites.
- If overwriting an existing file, you SHOULD use the read tool first to read the file's contents.
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.�{"required":["file_path","content"],"properties":{"file_path":{"description":"The absolute path to the file to write","type":"string"},"content":{"description":"The content to write to the file","type":"string"}},"type":"object","additionalProperties":false}R�

write_to_process�Writes input to an interactive process running in a shell with support for both text and special characters.

IMPORTANT: This command will NOT work if there is no command running in the shell. If you want to execute a command in the shell use the exec tool.

Provide exactly ONE of text_input or bytes_input (never both). To answer a prompt that needs an Enter keypress (e.g. a [y/n] prompt), set bytes_input to y<CR> (the y character followed by Enter).

Input options:
- text_input: Literal text content (no special character interpretation)
- bytes_input: Special characters using angle bracket notation (e.g., <ESC>, <CR>, <UP>, <C-c>)

Special character notation:
- <ESC> = Escape character
- <CR> = Carriage return (Enter)
- <LF> = Line feed (newline)
- <BS> = Backspace
- <UP>, <DOWN>, <LEFT>, <RIGHT> = Arrow keys
- <C-c>, <C-d>, <C-z> = Ctrl+key combinations
�{"required":["shell_id"],"properties":{"shell_id":{"description":"The ID of the shell to write to.","type":"string"},"text_input":{"description":"Text content to write to the shell (interpreted as literal text).","type":"string"},"bytes_input":{"description":"Special characters/bytes to write to the shell (interpreted with angle bracket notation).","type":"string"}},"type":"object","additionalProperties":false}z,
$76972368-42b8-44bc-8f1c-2f977116db20 �$1c0d7219-6cbb-45ca-9b72-4d4ee38a4b42��kimi-k3-high�$cbf2b153-7b13-428c-8730-eccf3c477c96