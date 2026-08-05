/**
 * Anthropic Messages 出口：writeOutboxRequest（IR → wire）+ readOutboxResponse（上游 SSE → IREvent）。
 *
 * writeOutboxRequest 是**唯一**恢复 Anthropic 位置不变量的地方：
 *   每个 tool_use 恰好一个 tool_result，且位于紧随该 assistant 回合之后那条 user 回合的最前面。
 * IR 内部靠 id 关联、与位置无关，所以三个入口都不需要各自维护这套排列规则 ——
 * agent-all-sdk-ts 里那份 179 行的 anthropic_constraints.ts 在这个架构下只剩这一个函数。
 *
 * 本文件同时是「IR → Anthropic Messages body」这份投影的**唯一授权定义**。
 * 不止一家上游说这条 wire（GitHub Copilot 的数据面就是 `${apiBase}/v1/messages` +
 * `anthropic-version: 2023-06-01`），它们之间的差别只有三处：端点与身份头、能力声明、
 * 以及对已投影 body 的方言复核。这三处收敛在 `AnthropicMessagesDialect` 里，
 * 投影本身**只有这一份** —— 复制一份出去就是 silent mirror：改了一边另一边不会失败，只会一起沉默。
 */
import { iterateSse, tryParseJson } from "../ir/sse.ts";
import type { OutboxResponseReadInterceptionOptions } from "../ir/ir_message_interception_extensions.ts";
import type {
  IRCapability, IROutbox, IROutboxProfile, IREvent, IRLoss, IRMandatoryFieldTable, OutboxRequestBuildResult,
  IRBuildProblem, IRPart, IRRequest, IRSessionIdentity,
  IRStopReason, IRTurn, IROutboxError, IRUsage,
} from "../ir/types.ts";

const SUPPORTED = [
  "stream", "nonStream", "systemPrompt", "multiTurn", "image", "document",
  "thinking", "thinkingSignature", "reasoningEffort", "reasoningBudget",
  "toolFunction", "toolBuiltin", "toolParallel", "toolChoiceSpecific",
  "toolResultImage", "toolResultError", "structuredOutput", "cacheBreakpoint",
  "contextEdit", "maxOutputTokens", "stopSequences", "temperature", "topP", "topK",
] as const satisfies readonly IRCapability[];

// toolFreeform：Anthropic 没有自由文本入参工具，只能包成单字段 JSON schema。
// toolGroup：没有 namespace 概念，只能把分组拍进名字。
// serviceTier：wire 上**有** `service_tier`，但取值集只有 `auto`（默认）与 `standard_only`
//   （官方 Messages 参考 + service-tiers 页）—— **没有 `priority` 这个取值**。IR 的
//   `priority` 在这条 wire 上表达不出来：能发的只有 `auto`，而 `auto` 本来就是缺省，
//   语义是「有 Priority 容量就用，没有就退回标准」，不是客户端要的「走优先通道」。
//   语料 0/807 条带 service_tier（也 0 条带 `speed`），所以连结构实证之上的行为实证都没有
//   —— 按 ARCHITECTURE §7，只能进 lossy。放行并留痕，不假装承载。
//
// 元素类型是 `Exclude<IRCapability, 已 supports 的>`：两个集合必须不相交。重叠时准入会
// 先命中 supports 直接放行，这条注释承诺的「强制留痕」就静默失效了 —— 那正是不变量 3 的反面。
const LOSSY = [
  "toolFreeform", "toolGroup", "serviceTier",
] as const satisfies readonly Exclude<IRCapability, (typeof SUPPORTED)[number]>[];

/**
 * Anthropic Messages **强制**要求 `max_tokens`：不给就编不出合法 body，本文件下面那条
 * `requiredFieldMissing` 拒绝就是它的执行体。语料 611/611 条 anthropic_messages 请求
 * 全部带 max_tokens，与 wire 契约一致。
 */
const MANDATORY: IRMandatoryFieldTable = { maxOutputTokens: true };

/**
 * 无已知危害。判据是**没有一条真实拒绝**是内容策略造成的：这家从未因系统提示词的
 * 内容本身拒过请求（拒绝都来自 wire 层的字段问题，那是 `writeOutboxRequest` 的事）。
 *
 * `false` 是一次表态，不是缺省 —— 新增一种危害时编译器会回到这里逼人重新回答。
 */

export interface AnthropicOutboxOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly anthropicVersion?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
}

/**
 * 说 Anthropic Messages wire 的一家上游与另一家的**全部**差别。
 *
 * 三个位置，一个都不多：
 *   - `resolveTarget`：端点与身份头。**按请求解析且是异步的** —— Copilot 的 session token
 *     会过期，凭据只能由调用方经 options 注入的回调提供；这里绝不伸手拿环境变量或本机文件。
 *   - `supports` / `lossy`：能力声明。两家跑的是同一份 body，但上游的行为实证不同。
 *   - `review`：对已投影 body 的方言复核。允许的动作只有两个 —— 删掉「目标 wire 真的没有
 *     这个位置」的字段并记 loss，或带精确 IR 路径拒绝。**改写成别的东西是策略，归 repair**，
 *     不在这里（ARCHITECTURE §7 的划线判据）。
 */
export interface AnthropicMessagesDialect {
  /** 写入这家 Outbox 自己产出的每一条 `IRLoss.outbox`。 */
  readonly outbox: string;
  /** 出站模型名。IR 里的 model 是客户端说的，映射由调用方决定，出口不猜。 */
  readonly model: string;
  readonly supports: readonly IRCapability[];
  readonly lossy: readonly IRCapability[];
  /** 目标强制要求的 IR 字段。两家跑同一条 wire，但表态各自给出，不许一家替另一家决定。 */
  readonly mandatory: IRMandatoryFieldTable;
  /** 目标的已知危害。同上：共享 wire 不等于共享上游策略层，两家各自表态。 */
  resolveTarget(request: IRRequest): Promise<AnthropicMessagesTarget>;
  review?(body: Record<string, unknown>, request: IRRequest): AnthropicMessagesDialectReview;
}

export interface AnthropicMessagesTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface AnthropicMessagesDialectReview {
  /** 复核后的 body。省略 = 原样采用（复核只提意见、不改字段的常见情况）。 */
  readonly body?: Record<string, unknown>;
  readonly losses?: readonly Omit<IRLoss, "stage" | "outbox">[];
  readonly problems?: readonly IRBuildProblem[];
}

class OutboxRequestReport {
  readonly #outbox: string;
  readonly #losses: IRLoss[] = [];
  readonly #problems: IRBuildProblem[] = [];
  constructor(outbox: string) {
    this.#outbox = outbox;
  }
  record(loss: Omit<IRLoss, "stage" | "outbox">): void {
    this.#losses.push({ stage: "outbox", outbox: this.#outbox, ...loss });
  }
  reject(problem: IRBuildProblem): void {
    this.#problems.push(problem);
  }
  get rejected(): boolean { return this.#problems.length > 0; }
  drain(): readonly IRLoss[] { return [...this.#losses]; }
  drainProblems(): readonly IRBuildProblem[] { return [...this.#problems]; }
}

/**
 * `IRSessionIdentity` → `metadata.user_id` 的字符串形态。空身份返回 null（字段整个不发）。
 *
 * 键名与键序都取自真实上行流量（`{"device_id","account_uuid","session_id"}`），不是自造：
 * 同一条 IR 两次构造必须得到同一串字节（determinism），而字面量的键序是稳定的。
 * 只写有值的键 —— 补一个空串会让下游把「没有」与「有但为空」混为一谈。
 */
function writeSessionIdentity(identity: IRSessionIdentity): string | null {
  const { deviceId, accountUuid, sessionId } = identity;
  if (deviceId === undefined && accountUuid === undefined && sessionId === undefined) return null;
  return JSON.stringify({
    ...(deviceId === undefined ? {} : { device_id: deviceId }),
    ...(accountUuid === undefined ? {} : { account_uuid: accountUuid }),
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  });
}

/** 分组名拍进工具名。这是有损的（分组结构没了），调用方靠 loss 知道。 */
function flatToolName(group: string | null, name: string): string {
  return group === null ? name : `${group}__${name}`;
}

function writePartToOutbox(part: IRPart, path: string, report: OutboxRequestReport): Record<string, unknown> | null {
  const cache = part.cacheBreakpoint === undefined ? {} : { cache_control: { type: "ephemeral" } };
  switch (part.kind) {
    case "text":
      if (part.text.length === 0) {
        report.record({
          path,
          kind: "dropped",
          detail: "empty text block is rejected by this wire and was omitted, including any cache breakpoint",
        });
        return null;
      }
      return { type: "text", text: part.text, ...cache };
    case "image":
      return {
        type: "image",
        source: part.media.source.kind === "base64"
          ? { type: "base64", media_type: part.media.mediaType, data: part.media.source.data }
          : { type: "url", url: part.media.source.url },
        ...cache,
      };
    case "document":
      return {
        type: "document",
        source: part.media.source.kind === "base64"
          ? { type: "base64", media_type: part.media.mediaType, data: part.media.source.data }
          : { type: "url", url: part.media.source.url },
        ...(part.title === undefined ? {} : { title: part.title }),
        ...cache,
      };
    case "thinking":
      // 没有 signature 的 thinking 块会被上游拒；宁可丢块也不能让整条请求 400。
      if (part.signature === undefined) {
        report.record({ path, kind: "dropped", detail: "thinking block without signature is rejected upstream" });
        return null;
      }
      return { type: "thinking", thinking: part.text, signature: part.signature, ...cache };
    case "redactedThinking":
      return { type: "redacted_thinking", data: part.data, ...cache };
    case "toolCall":
      return {
        type: "tool_use",
        id: part.call.id,
        name: flatToolName(part.call.toolRef.group, part.call.toolRef.name),
        input: part.call.input.kind === "json" ? part.call.input.value : { input: part.call.input.text },
        ...(part.call.caller === undefined ? {} : { caller: part.call.caller.raw }),
        ...cache,
      };
    case "toolResult": {
      const inner = part.result.parts
        .map((child, index) => writePartToOutbox(child, `${path}.result.parts[${index}]`, report))
        .filter((block): block is Record<string, unknown> => block !== null);
      return {
        type: "tool_result",
        tool_use_id: part.result.callId,
        // 空结果必须给一个占位：空数组与空串在部分端点上都会 400。
        content: inner.length === 0 ? "" : inner,
        ...(part.result.status === "error" ? { is_error: true } : {}),
        ...cache,
      };
    }
    case "opaque":
      // 同源的 opaque 原样放回（无损往返）；异源的没法翻译，丢弃并留痕。
      if (part.origin === "anthropic_messages") return part.raw as Record<string, unknown>;
      report.record({
        path, kind: "dropped",
        detail: `opaque part from ${part.origin} (${part.tag}) has no Anthropic representation`,
      });
      return null;
  }
}

/**
 * 恢复 Anthropic 的工具回合位置不变量。
 *
 * 「先全摘下来再重排」而不是「就地打补丁」：就地修补要按每种破坏方式各堵一次，且步骤间
 * 有顺序陷阱（实测踩过：占位块 push 到 user 回合末尾会变成 [tool_result, text, tool_result]，
 * 上游 400；[text, tool_result] 顺序必死，[tool_result, text] 才过）。
 *
 * 分界线与 openai_chat_completions 出口一致：
 *   - 位置重排、空结果补最小合法值 → wire 事实，留在 Core；
 *   - 悬空调用（缺结果）、孤儿结果（多结果）→ 补什么措辞/丢不丢都是「我替你决定」，
 *     Core 一律带精确 IR 路径拒绝，由调用方显式 compose `src/repair` 决定。
 *   两者都会让上游 400，但前者的补法是 wire 强制的，后者是策略。
 */
function arrangeToolTurns(turns: readonly IRTurn[], report: OutboxRequestReport): IRTurn[] {
  // 1. 摘出全部工具结果，按 callId 索引（带精确路径，拒绝时要把位置指到那个 part）
  const resultsByCallId = new Map<string, { part: IRPart; path: string }>();
  const stripped: IRTurn[] = turns.map((turn, turnIndex) => ({
    role: turn.role,
    parts: turn.parts.filter((part, partIndex) => {
      if (part.kind !== "toolResult") return true;
      resultsByCallId.set(part.result.callId, {
        part,
        path: `$.conversation.turns[${turnIndex}].parts[${partIndex}]`,
      });
      return false;
    }),
  }));

  // 2. 每个 assistant 回合之后，按该回合声明的调用顺序重铺结果
  const arranged: IRTurn[] = [];
  const consumed = new Set<string>();
  for (let turnIndex = 0; turnIndex < stripped.length; turnIndex++) {
    const turn = stripped[turnIndex]!;
    arranged.push(turn);
    if (turn.role !== "assistant") continue;
    const calls = turn.parts.flatMap((part, partIndex): Array<{ id: string; path: string }> =>
      part.kind === "toolCall"
        ? [{ id: part.call.id, path: `$.conversation.turns[${turnIndex}].parts[${partIndex}]` }]
        : [],
    );
    if (calls.length === 0) continue;
    const resultParts: IRPart[] = [];
    for (const call of calls) {
      const found = resultsByCallId.get(call.id);
      if (found !== undefined) { resultParts.push(found.part); consumed.add(call.id); continue; }
      // 悬空调用：客户端历史缺了结果。Anthropic 不接受 tool_use 没有紧随的 tool_result；
      // 补什么占位措辞是「我替你决定」—— 拒绝，把位置指到这个 toolCall part。
      report.reject({
        kind: "danglingToolCall",
        path: call.path,
        detail: `tool call ${call.id} has no tool result in the conversation; Anthropic rejects a `
          + "tool_use without a following tool_result, and the gateway will not invent one "
          + "(compose repair 'fillDanglingToolCall' to choose the placeholder wording)",
      });
    }
    // tool_result 必须排在紧随其后那条 user 回合的**最前面**
    arranged.push({ role: "user", parts: resultParts });
  }

  // 3. 孤儿结果（前面根本没有对应调用）留着上游必 400；丢不丢是决定 —— 拒绝，指到那个 part。
  for (const [callId, found] of resultsByCallId) {
    if (consumed.has(callId)) continue;
    report.reject({
      kind: "orphanToolResult",
      path: found.path,
      detail: `tool result ${callId} has no matching tool call; Anthropic rejects an unexpected `
        + "tool_use_id, and dropping it would hide an output the client did send "
        + "(compose repair 'dropOrphanToolResult' to discard it deliberately)",
    });
  }

  // 4. 重铺后可能出现相邻同角色（assistant 无调用 + 原有 user），合并
  const merged: IRTurn[] = [];
  for (const turn of arranged) {
    if (turn.parts.length === 0) continue;
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === turn.role) {
      merged[merged.length - 1] = { role: previous.role, parts: [...previous.parts, ...turn.parts] };
      continue;
    }
    merged.push(turn);
  }
  return merged;
}

/**
 * Anthropic Messages wire 的出口工厂。**投影只有这一份**，方言只换端点、身份头、
 * 能力声明与复核 —— `createAnthropicOutbox` 与 `createCopilotOutbox` 都是它的薄封装。
 *
 * `readOutboxResponse` 不做方言化：读回来的就是同一条 wire 的同一套 SSE 事件，
 * 给它开一个 hook 等于给「Anthropic 事件语义」开第二份认知。
 */
export function createAnthropicMessagesOutbox(dialect: AnthropicMessagesDialect): IROutbox {
  const profile: IROutboxProfile = {
    supports: new Set(dialect.supports),
    lossy: new Set(dialect.lossy),
    mandatory: dialect.mandatory,
  };

  return {
    profile,

    async writeOutboxRequest(request: IRRequest): Promise<OutboxRequestBuildResult> {
      const report = new OutboxRequestReport(dialect.outbox);
      const { conversation, intent } = request;

      const system = conversation.system
        .map((part, index) => writePartToOutbox(part, `$.conversation.system[${index}]`, report))
        .filter((block): block is Record<string, unknown> => block !== null);

      const messages = arrangeToolTurns(conversation.turns, report).map((turn, turnIndex) => ({
        role: turn.role,
        content: turn.parts
          .map((part, partIndex) => writePartToOutbox(part, `$.conversation.turns[${turnIndex}].parts[${partIndex}]`, report))
          .filter((block): block is Record<string, unknown> => block !== null),
      })).filter((message) => message.content.length > 0);

      // 全部回合都编不出内容时，产出的是 `messages: []` —— Anthropic 必 400。
      // 「既不拒绝也不留痕地发一个必然失败的 body」正是这次改造要消灭的形态。
      if (messages.length === 0) {
        report.reject({
          kind: "requiredFieldMissing",
          path: "$.conversation.turns",
          detail: "no turn produced any content Anthropic can carry; the request would be rejected upstream as an empty message list",
        });
      }

      const tools = conversation.toolset.tools.map((tool) => {
        if (tool.ref.group !== null) {
          report.record({
            path: `$.conversation.toolset.tools`, kind: "degraded",
            detail: `tool group '${tool.ref.group}' flattened into the tool name; Anthropic has no namespace concept`,
          });
        }
        const name = flatToolName(tool.ref.group, tool.ref.name);
        if (tool.kind === "function") {
          return { name, description: tool.description, input_schema: tool.schema };
        }
        if (tool.kind === "freeform") {
          report.record({
            path: `$.conversation.toolset.tools`, kind: "degraded",
            detail: `freeform tool '${name}' wrapped into a single-field JSON schema`,
          });
          return {
            name, description: tool.description,
            input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          };
        }
        return { type: tool.builtin, name, ...(tool.config ?? {}) };
      });

      const choice = conversation.toolset.choice.value;
      const toolChoice =
        choice.kind === "auto" ? { type: "auto" }
        : choice.kind === "none" ? { type: "none" }
        : choice.kind === "required" ? { type: "any" }
        : { type: "tool", name: flatToolName(choice.ref.group, choice.ref.name) };

      const reasoning = intent.reasoning.value;
      const thinking =
        reasoning.mode === "disabled" ? { type: "disabled" }
        : reasoning.mode === "adaptive" ? { type: "adaptive", display: reasoning.display }
        : reasoning.budgetTokens !== undefined ? { type: "enabled", budget_tokens: reasoning.budgetTokens }
        : undefined;

      const outputFormat = intent.outputFormat.value;
      // effort **原样下发，不夹档、不记 loss**：`IREffort` 的六档就是 Anthropic 自己的档位
      // 集合（`output_config.effort`），这条路上没有更窄的枚举要夹。`reasoningEffort` 因此
      // 落在 SUPPORTED 而不是 LOSSY —— 另两个 OpenAI 出口的夹档 loss 在这里没有对应物，
      // 不是漏记。
      const outputConfig = {
        ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
        ...(outputFormat.kind === "jsonSchema"
          ? { format: { type: "json_schema", schema: outputFormat.schema, ...(outputFormat.name === undefined ? {} : { name: outputFormat.name }) } }
          : {}),
      };

      // Anthropic 强制要求 max_tokens。客户端没给（Chat Completions 客户端普遍不带）时，
      // 补 4096 是「我替你决定」—— 拒绝，把位置指到 intent 上。要兜底就显式 compose
      // repair（对 Chat→Anthropic 转发，那里有 entry 的 maxOutputTokens 可作真默认值）。
      // 服务档位。wire 上的 `service_tier` 只收 `auto`（缺省）/ `standard_only`，
      // **没有 `priority`**：客户端要的「走优先通道」在这条 wire 上没有取值可表达，
      // 发一个 `auto` 等于把缺省值又写一遍，并不会让这条请求排到优先队列。
      // 于是这里既不发也不假装 —— 带精确路径记一条 dropped（能力表里它也在 lossy）。
      if (intent.serviceTier.source === "client" && intent.serviceTier.value === "priority") {
        report.record({
          path: "$.intent.serviceTier", kind: "dropped",
          detail: "Anthropic Messages service_tier only accepts 'auto' (the default) and 'standard_only'; "
            + "there is no per-request value that means 'priority', so the client's priority intent is not "
            + "forwarded (priority capacity is an organisation-level commitment, not a request parameter)",
        });
      }

      const maxTokens = intent.stopping.maxOutputTokens?.value;
      if (maxTokens === undefined) {
        report.reject({
          kind: "requiredFieldMissing",
          path: "$.intent.stopping.maxOutputTokens",
          detail: "Anthropic requires max_tokens; the client did not supply one and the gateway "
            + "will not invent a value (compose repair to pick a default)",
        });
      }

      // 会话身份。Anthropic Messages wire **有**承载位：`metadata.user_id`（官方参考：
      // 「An external identifier for the user who is associated with the request. This should be
      // a uuid, hash value, or other opaque identifier.」）。它就是 Claude Code 的原始形态 ——
      // 语料 365/611 条 anthropic_messages 请求带 `metadata.user_id`，且 365/365 是
      // `{"device_id","account_uuid","session_id"}` 的 JSON 串（accountType 全是 copilot，
      // 也就是说这条 wire 上两家上游都真实受理过它）。ingress 的 `parseSessionIdentity` 解的
      // 正是这个串，这里是它的逆 —— 有位置就发，不发才是不变量 3 的反面。
      const metadataUserId = writeSessionIdentity(intent.identity);

      const body: Record<string, unknown> = {
        model: dialect.model,
        messages,
        max_tokens: maxTokens,
        stream: intent.stream.value,
        ...(metadataUserId === null ? {} : { metadata: { user_id: metadataUserId } }),
        ...(system.length === 0 ? {} : { system }),
        ...(tools.length === 0 ? {} : { tools }),
        ...(tools.length === 0 || conversation.toolset.choice.source !== "client" ? {} : { tool_choice: toolChoice }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
        ...(intent.sampling.temperature === undefined ? {} : { temperature: intent.sampling.temperature.value }),
        ...(intent.sampling.topP === undefined ? {} : { top_p: intent.sampling.topP.value }),
        ...(intent.sampling.topK === undefined ? {} : { top_k: intent.sampling.topK.value }),
        ...(intent.stopping.stopSequences === undefined ? {} : { stop_sequences: [...intent.stopping.stopSequences.value] }),
        ...(intent.contextEdits.length === 0 ? {} : { context_management: { edits: intent.contextEdits.map((edit) => edit.raw) } }),
      };

      // 方言复核跑在这里而不是各自的工厂里：它必须看到**共享投影的产物**，
      // 才不会与投影漂移（复核一个自己重编的 body 就又是两份认知了）。
      const reviewed = dialect.review?.(body, request);
      for (const loss of reviewed?.losses ?? []) report.record(loss);
      for (const problem of reviewed?.problems ?? []) report.reject(problem);

      // 拒绝是收集齐再返回：已经记下的 loss 一并交出（有损是既成事实，拒绝不改写它）。
      if (report.rejected) {
        return { ok: false, problems: report.drainProblems(), losses: report.drain() };
      }

      // 凭据在这一步才解析：编不出 wire 的请求不值得去刷一次 token。
      const target = await dialect.resolveTarget(request);
      return {
        ok: true,
        wire: {
          url: target.url,
          method: "POST",
          headers: target.headers,
          body: JSON.stringify(reviewed?.body ?? body),
        },
        losses: report.drain(),
      };
    },

    readOutboxResponse(response: Response, readOptions?: OutboxResponseReadInterceptionOptions): AsyncIterable<IREvent> {
      return liftAnthropicStream(response, readOptions);
    },
  };
}

/** 原生 Anthropic：`x-api-key` + 固定 baseUrl，没有方言复核。 */
export function createAnthropicOutbox(options: AnthropicOutboxOptions): IROutbox {
  return createAnthropicMessagesOutbox({
    outbox: "anthropic",
    model: options.model,
    supports: SUPPORTED,
    lossy: LOSSY,
    mandatory: MANDATORY,
    resolveTarget: () => Promise.resolve({
      url: `${options.baseUrl.replace(/\/$/u, "")}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": options.anthropicVersion ?? "2023-06-01",
        ...(options.extraHeaders ?? {}),
      },
    }),
  });
}

// ── readOutboxResponse ───────────────────────────────────────────────────────────────────

function mapStopReason(raw: unknown): IRStopReason {
  switch (raw) {
    case "end_turn": return "endTurn";
    case "max_tokens": return "maxTokens";
    case "stop_sequence": return "stopSequence";
    case "tool_use": return "toolUse";
    case "refusal": return "refusal";
    default: return "endTurn";
  }
}

/**
 * 上游错误 → IR 分类。三级证据，**从强到弱**，先命中先用：
 *
 *   1. **正文语义**（最强）—— 上游明说了这次失败的具体原因
 *   2. **错误类型**（次之）—— 上游给的粗分类
 *   3. **HTTP 状态码**（兜底）—— 正文完全没有可用信号时的最后依据
 *
 * 顺序不是随便排的，两条踩过的坑：
 *
 * - **上下文超长必须排在 `invalid_request_error` 之前**。Anthropic 对「prompt is too long:
 *   214253 tokens > 200000 maximum」回的 type 就是 `invalid_request_error`，把类型判断排在
 *   前面会让上下文超长这一支**永远不可达** —— 调用方看到的是笼统的「请求无效」，
 *   压缩上下文这条唯一正确的自救路径就此消失。
 * - **状态码必须参与分类**。上游前面挂着 nginx / Cloudflare 时，5xx 的正文是 HTML 或纯文本
 *   （`error code: 524`），解不出 type 也解不出 message。只看正文会把这些瞬时故障判成
 *   `unknown` + 不可重试，本该退避重试的请求直接失败。
 */
const UPSTREAM_ERROR_TYPE_KINDS: Readonly<Record<string, IROutboxError["kind"]>> = {
  invalid_request_error: "invalidRequest",
  authentication_error: "permissionDenied",
  permission_error: "permissionDenied",
  permission_denied: "permissionDenied",
  rate_limit_error: "rateLimited",
  overloaded_error: "outboxUnavailable",
  api_error: "outboxUnavailable",
};

/** 正文语义证据。命中即定，压过类型与状态码。 */
const CONTEXT_LENGTH_PATTERN = /context.{0,12}length|too long|exceeds? the (maximum|context)/iu;

function kindFromHttpStatus(httpStatus: number | null): IROutboxError["kind"] {
  if (httpStatus === null) return "unknown";
  if (httpStatus === 401 || httpStatus === 403) return "permissionDenied";
  if (httpStatus === 429) return "rateLimited";
  if (httpStatus === 408) return "outboxUnavailable";
  // 5xx 一律当上游暂时不可用：包含 520–529 这些 Cloudflare 自造码，
  // 只枚举 500/502/503/504 会把边缘层的瞬时故障判成不可重试。
  if (httpStatus >= 500) return "outboxUnavailable";
  if (httpStatus >= 400) return "invalidRequest";
  return "unknown";
}

/** 可重试性由 kind 单点派生，不在各处各判一次。 */
function isRetryableKind(kind: IROutboxError["kind"]): boolean {
  return kind === "rateLimited" || kind === "outboxUnavailable" || kind === "transport";
}

function mapOutboxError(payload: unknown, httpStatus: number | null): IROutboxError {
  const holder = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const inner = typeof holder.error === "object" && holder.error !== null
    ? holder.error as Record<string, unknown> : holder;
  const type = typeof inner.type === "string" ? inner.type : "";
  const bodyMessage = typeof inner.message === "string" ? inner.message : null;
  // 正文不是 JSON 时（nginx HTML / "error code: 524"），原始文本本身就是唯一的语义线索。
  // 空串不算证据：上游可能什么都没回（连接被中间层掐断时常见）。
  const rawText = typeof payload === "string" && payload.trim().length > 0 ? payload : null;
  const evidence = bodyMessage ?? rawText ?? "";

  const kind: IROutboxError["kind"] =
    CONTEXT_LENGTH_PATTERN.test(evidence) ? "contextLengthExceeded"
    : UPSTREAM_ERROR_TYPE_KINDS[type] ?? kindFromHttpStatus(httpStatus);

  return {
    kind,
    httpStatus,
    // message 永远非空：它是日志与下发披露的唯一线索，空串等于把故障现场抹掉。
    message: bodyMessage
      ?? (rawText === null
        ? (httpStatus === null ? "upstream error" : `upstream returned HTTP ${httpStatus} with no error body`)
        : rawText.slice(0, 500)),
    retryable: isRetryableKind(kind),
    raw: payload,
  };
}

function usageFrom(raw: unknown): IRUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

async function* liftAnthropicStream(
  response: Response, readOptions?: OutboxResponseReadInterceptionOptions,
): AsyncGenerator<IREvent> {
  // 非 2xx：整体读出来当一次性错误，不进 SSE 解析。
  if (!response.ok) {
    const text = await response.text();
    yield { kind: "error", error: mapOutboxError(tryParseJson(text) ?? text, response.status) };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // 非流式：一次性 Message JSON 转成等价事件序列，下游 encode 不需要区分两条路径。
    const text = await response.text();
    const payload = tryParseJson<Record<string, unknown>>(text);
    if (payload === null) {
      yield { kind: "error", error: mapOutboxError(text, response.status) };
      return;
    }
    if (payload.type === "error") {
      yield { kind: "error", error: mapOutboxError(payload, response.status) };
      return;
    }
    yield { kind: "messageStart", model: typeof payload.model === "string" ? payload.model : "" };
    const content = Array.isArray(payload.content) ? payload.content : [];
    let index = 0;
    for (const block of content) {
      const part = blockToPart(block);
      if (part === null) { yield { kind: "unhandled", rawType: "content_block", raw: block }; continue; }
      yield { kind: "partStart", index, part };
      yield { kind: "partEnd", index };
      index += 1;
    }
    const usage = usageFrom(payload.usage);
    if (usage !== null) yield { kind: "usage", usage };
    yield { kind: "messageStop", reason: mapStopReason(payload.stop_reason) };
    return;
  }

  const toolInputBuffers = new Map<number, string>();
  let sawTerminal = false;

  for await (const frame of iterateSse(response, readOptions?.inspectCompleteSseFrame)) {
    const payload = tryParseJson<Record<string, unknown>>(frame.data);
    if (payload === null) {
      yield { kind: "unhandled", rawType: frame.event ?? "<no-event>", raw: frame.data };
      continue;
    }
    const type = typeof payload.type === "string" ? payload.type : (frame.event ?? "");

    switch (type) {
      case "message_start": {
        const message = typeof payload.message === "object" && payload.message !== null
          ? payload.message as Record<string, unknown> : {};
        yield { kind: "messageStart", model: typeof message.model === "string" ? message.model : "" };
        const usage = usageFrom(message.usage);
        if (usage !== null) yield { kind: "usage", usage };
        break;
      }

      case "content_block_start": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const part = blockToPart(payload.content_block);
        if (part === null) { yield { kind: "unhandled", rawType: "content_block_start", raw: payload }; break; }
        if (part.kind === "toolCall") toolInputBuffers.set(index, "");
        yield { kind: "partStart", index, part };
        break;
      }

      case "content_block_delta": {
        const index = typeof payload.index === "number" ? payload.index : 0;
        const delta = typeof payload.delta === "object" && payload.delta !== null
          ? payload.delta as Record<string, unknown> : {};
        switch (delta.type) {
          case "text_delta":
            yield { kind: "partDelta", index, delta: { kind: "text", text: String(delta.text ?? "") } };
            break;
          case "thinking_delta":
            yield { kind: "partDelta", index, delta: { kind: "thinking", text: String(delta.thinking ?? "") } };
            break;
          case "signature_delta":
            yield { kind: "partDelta", index, delta: { kind: "thinkingSignature", signature: String(delta.signature ?? "") } };
            break;
          case "input_json_delta": {
            const json = String(delta.partial_json ?? "");
            toolInputBuffers.set(index, (toolInputBuffers.get(index) ?? "") + json);
            yield { kind: "partDelta", index, delta: { kind: "toolInputJson", json } };
            break;
          }
          default:
            yield { kind: "unhandled", rawType: `content_block_delta:${String(delta.type)}`, raw: payload };
        }
        break;
      }

      case "content_block_stop":
        yield { kind: "partEnd", index: typeof payload.index === "number" ? payload.index : 0 };
        break;

      case "message_delta": {
        const usage = usageFrom(payload.usage);
        if (usage !== null) yield { kind: "usage", usage };
        const delta = typeof payload.delta === "object" && payload.delta !== null
          ? payload.delta as Record<string, unknown> : {};
        if (delta.stop_reason !== undefined) {
          sawTerminal = true;
          yield { kind: "messageStop", reason: mapStopReason(delta.stop_reason) };
        }
        break;
      }

      case "message_stop":
        if (!sawTerminal) { sawTerminal = true; yield { kind: "messageStop", reason: "endTurn" }; }
        break;

      case "error":
        sawTerminal = true;
        yield { kind: "error", error: mapOutboxError(payload, null) };
        break;

      case "ping":
        break;

      default:
        // 不变量 4：没匹配上的事件是流里的元素，不是 switch 的黑洞。
        yield { kind: "unhandled", rawType: type.length === 0 ? "<empty>" : type, raw: payload };
    }
  }

  // 上游把流掐断却没发终止帧：必须显式终止，否则调用方看到的是「200 但空」。
  if (!sawTerminal) {
    yield {
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a terminal event",
        raw: null,
      },
    };
  }
}

function blockToPart(raw: unknown): IRPart | null {
  if (typeof raw !== "object" || raw === null) return null;
  const block = raw as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return { kind: "text", text: typeof block.text === "string" ? block.text : "" };
    case "thinking": {
      const signature = typeof block.signature === "string" ? block.signature : undefined;
      return {
        kind: "thinking",
        text: typeof block.thinking === "string" ? block.thinking : "",
        ...(signature === undefined ? {} : { signature }),
      };
    }
    case "redacted_thinking":
      return { kind: "redactedThinking", data: typeof block.data === "string" ? block.data : "" };
    case "tool_use": {
      const id = typeof block.id === "string" ? block.id : null;
      const name = typeof block.name === "string" ? block.name : null;
      if (id === null || name === null) return null;
      return {
        kind: "toolCall",
        call: {
          id, toolRef: { group: null, name },
          input: { kind: "json", value: typeof block.input === "object" && block.input !== null ? block.input as Record<string, unknown> : {} },
        },
      };
    }
    default:
      return null;
  }
}
