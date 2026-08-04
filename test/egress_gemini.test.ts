/**
 * Gemini CloudCode 出口。
 *
 * 报文形状全部取自真实抓包：`~/agent-gateway-traffic-logs/*.ndjson` 里
 * `"phase":"upstream_sse"` 的 `raw` 字段（2026-08-02..04 共 8463 条，part 形态五种、
 * finishReason 仅 STOP/MAX_TOKENS）。签名串按原文前缀截短 —— 这里锁的是**形状**，不是长度。
 *
 * 这个出口与 Anthropic 的差别是结构性的（没有 content_block 生命周期事件、终止靠
 * finishReason），所以测试的重点也不同：合成出来的 partStart/partEnd 是否自洽，
 * 以及「没等到 finishReason」是否**必然**变成 error 而不是一个安静的空成功。
 */
import { describe, expect, it } from "bun:test";
import {
  clearThoughtSignatureCache, createGeminiCloudCodeUpstream,
} from "../src/egress/gemini_cloudcode.ts";
import { deriveCapabilityNeeds } from "../src/ir/capabilities.ts";
import { checkUpstreamSupport } from "../src/ir/admission.ts";
import { assembleResponse } from "../src/ir/response.ts";
import { clientValue, defaultValue } from "../src/ir/types.ts";
import type {
  IRBuildProblem, IREvent, IRIntent, IRPart, IRRequest, IRToolset, IRTurn, IRWireRequest, IRLoss,
} from "../src/ir/types.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const egress = createGeminiCloudCodeUpstream({
  model: "gemini-3.6-flash-high",
  accessToken: "ya29.test-token",
  project: "default-cli-project",
  modelEnum: "MODEL_PLACEHOLDER_M71",
  sessionId: "1785856733829",
  requestIdFactory: () => "agent/1785856733829/1785856733829/deadbeef/2",
});

const EMPTY_TOOLSET: IRToolset = {
  tools: [],
  groups: [],
  choice: defaultValue({ kind: "auto" }),
  parallel: defaultValue(true),
};

function intent(overrides: Partial<IRIntent> = {}): IRIntent {
  return {
    reasoning: defaultValue({ mode: "adaptive", display: "summarized" }),
    outputFormat: defaultValue({ kind: "text" }),
    serviceTier: defaultValue("standard"),
    sampling: {},
    stopping: {},
    contextEdits: [],
    stream: clientValue(true),
    identity: {},
    ...overrides,
  };
}

function request(
  parts: { system?: readonly IRPart[]; turns: readonly IRTurn[]; toolset?: IRToolset; intent?: IRIntent },
): IRRequest {
  const base = {
    traceId: "tr_test",
    protocol: "anthropic_messages" as const,
    model: "claude-opus-4-6",
    conversation: {
      system: parts.system ?? [],
      turns: parts.turns,
      toolset: parts.toolset ?? EMPTY_TOOLSET,
    },
    intent: parts.intent ?? intent(),
  };
  return { ...base, requires: deriveCapabilityNeeds(base) };
}

function sse(chunks: readonly unknown[]): Response {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(events: AsyncIterable<IREvent>): Promise<IREvent[]> {
  const out: IREvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * `writeUpstreamRequest` 是**编译或拒绝**的判别联合。成功用例统一从这里剥出 wire ——
 * 万一被拒，失败信息里直接是 problems，而不是一句「wire is undefined」。
 */
async function compiled(request: IRRequest): Promise<{
  readonly wire: IRWireRequest;
  readonly losses: readonly IRLoss[];
}> {
  const built = await egress.writeUpstreamRequest(request);
  if (!built.ok) throw new Error(`expected a compiled request, got problems: ${JSON.stringify(built.problems)}`);
  return { wire: built.wire, losses: built.losses };
}

/** 期望拒绝。返回 problems 与拒绝前已记下的 losses（契约要求两者一并交出）。 */
async function rejected(request: IRRequest): Promise<{
  readonly problems: readonly IRBuildProblem[];
  readonly losses: readonly IRLoss[];
}> {
  const built = await egress.writeUpstreamRequest(request);
  if (built.ok) throw new Error(`expected a rejection, got a wire: ${built.wire.body}`);
  return { problems: built.problems, losses: built.losses };
}

// 真实抓包的签名前缀（原文 400~1200 字符，此处截短）。
const REAL_SIG_FUNCTION_CALL = "ErgECrUEARFNMg+a3sX9Aj1VZcBHu5KuF0lEdZZXWygg5OBooRLMZybN4umtHKbE";
const REAL_SIG_TAIL = "EokCCoYCARFNMg82jtzAzJF/OepWGJ2DKPHL6fOjytTBn/FylkKFyxEDtDaful";

/** trace tr_msaofo0n_a（2026-08-02）：思考 4 块 → 正文 1 块 → 空 text + 签名 + STOP。 */
const REAL_TEXT_STREAM: readonly unknown[] = [
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ thought: true, text: "**Focusing on Precision**\n\n" }] } }],
      usageMetadata: { promptTokenCount: 26489, totalTokenCount: 26489 },
      modelVersion: "gemini-3.6-flash",
      responseId: "R2xxauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ thought: true, text: "**Analyzing Conflicting Directives**\n\n" }] } }],
      usageMetadata: { promptTokenCount: 26489, totalTokenCount: 26489 },
      modelVersion: "gemini-3.6-flash",
      responseId: "R2xxauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }],
      usageMetadata: { promptTokenCount: 26489, candidatesTokenCount: 2, totalTokenCount: 27671, thoughtsTokenCount: 1180 },
      modelVersion: "gemini-3.6-flash",
      responseId: "R2xxauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "喵" }] } }],
      usageMetadata: { promptTokenCount: 26489, candidatesTokenCount: 2, totalTokenCount: 27671, thoughtsTokenCount: 1180 },
      modelVersion: "gemini-3.6-flash",
      responseId: "R2xxauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
  {
    response: {
      candidates: [{
        content: { role: "model", parts: [{ thoughtSignature: REAL_SIG_TAIL, text: "" }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 26489, candidatesTokenCount: 2, totalTokenCount: 27671, thoughtsTokenCount: 1180 },
      modelVersion: "gemini-3.6-flash",
      responseId: "R2xxauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
];

/** trace tr_msb8qo38_c（2026-08-02）：functionCall + 签名 → 空 text + STOP。 */
const REAL_TOOL_STREAM: readonly unknown[] = [
  {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{
            thoughtSignature: REAL_SIG_FUNCTION_CALL,
            functionCall: {
              name: "glob",
              args: { i: "Searching for files in current directory", hidden: true, gitignore: false, path: "**/*" },
              id: "cKU4A4Y3",
            },
          }],
        },
      }],
      usageMetadata: { promptTokenCount: 26862, candidatesTokenCount: 34, totalTokenCount: 27009, thoughtsTokenCount: 113 },
      modelVersion: "gemini-3.6-flash",
      responseId: "bbluauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
  {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 26862, candidatesTokenCount: 34, totalTokenCount: 27009, thoughtsTokenCount: 113 },
      modelVersion: "gemini-3.6-flash",
      responseId: "bbluauHbGeHi_uMPrd_rkAo",
    },
    traceId: "f2dadfefe2fcb8e2",
    metadata: {},
  },
];

// ── profile ─────────────────────────────────────────────────────────────────

describe("能力声明", () => {
  it("没有实测证据的能力不进 supports，也不进 lossy —— 由准入判该出口不可用", () => {
    const { supports, lossy } = egress.profile;
    for (const capability of ["toolBuiltin", "structuredOutput"] as const) {
      expect(supports.has(capability)).toBe(false);
      expect(lossy.has(capability)).toBe(false);
    }
    // 有损但能承载的，必须在 lossy 里（准入会强制记一条），不能混进 supports。
    for (const capability of ["cacheBreakpoint", "thinkingSignature", "reasoningEffort", "contextEdit"] as const) {
      expect(supports.has(capability)).toBe(false);
      expect(lossy.has(capability)).toBe(true);
    }
    expect(supports.has("thinking")).toBe(true);
    expect(supports.has("reasoningBudget")).toBe(true);
  });

  it("cacheBreakpoint 走准入必然产出一条 loss（PROTOCOL_REFERENCE §7：agy 不支持 prompt caching）", () => {
    const verdict = checkUpstreamSupport(
      request({
        system: [{ kind: "text", text: "you are a gateway", cacheBreakpoint: { scope: "ephemeral" } }],
        turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      }),
      egress.profile,
    );
    expect(verdict.admitted).toBe(true);
    expect(verdict.losses.some((loss) => loss.detail.includes("cacheBreakpoint"))).toBe(true);
  });

  it("structuredOutput 直接判不可用，并带着精确 IR 路径", () => {
    const verdict = checkUpstreamSupport(
      request({
        turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
        intent: intent({
          outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }),
        }),
      }),
      egress.profile,
    );
    expect(verdict.admitted).toBe(false);
    expect(verdict.unsupported.map((need) => need.capability)).toContain("structuredOutput");
    expect(verdict.unsupported[0]?.paths).toContain("$.intent.outputFormat");
  });
});

// ── lower ───────────────────────────────────────────────────────────────────

describe("lower：IR → v1internal wire", () => {
  it("system + 多轮 + 并行工具 + 工具结果 + 图片 → contents/parts/functionDeclarations", async () => {
    clearThoughtSignatureCache();
    const toolset: IRToolset = {
      tools: [
        {
          kind: "function",
          ref: { group: null, name: "glob" },
          description: "find files",
          schema: {
            type: "object",
            properties: { path: { type: "string" }, hidden: { type: ["boolean", "null"] } },
            required: ["path"],
            additionalProperties: false,
            $schema: "http://json-schema.org/draft-07/schema#",
          },
        },
        { kind: "function", ref: { group: null, name: "read" }, description: "read a file", schema: { type: "object", properties: {} } },
      ],
      groups: [],
      choice: clientValue({ kind: "specific", ref: { group: null, name: "glob" } }),
      parallel: clientValue(true),
    };
    const result = await compiled(request({
      system: [{ kind: "text", text: "you are a gateway" }, { kind: "text", text: "be terse" }],
      toolset,
      turns: [
        { role: "user", parts: [{ kind: "text", text: "list files" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "on it" },
            { kind: "toolCall", call: { id: "call_a", toolRef: { group: null, name: "glob" }, input: { kind: "json", value: { path: "**/*" } } } },
            { kind: "toolCall", call: { id: "call_b", toolRef: { group: null, name: "read" }, input: { kind: "json", value: { path: "a.txt" } } } },
          ],
        },
        {
          role: "user",
          parts: [
            { kind: "toolResult", result: { callId: "call_a", parts: [{ kind: "text", text: "a.txt\nb.txt" }], status: "ok" } },
            { kind: "toolResult", result: { callId: "call_b", parts: [{ kind: "text", text: "boom" }], status: "error" } },
            { kind: "image", media: { source: { kind: "base64", data: "iVBORw0K" }, mediaType: "image/png" } },
          ],
        },
      ],
    }));

    const body = JSON.parse(result.wire.body) as Record<string, any>;
    expect(result.wire.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(result.wire.headers.authorization).toBe("Bearer ya29.test-token");
    expect(result.wire.headers.accept).toBe("text/event-stream");
    expect(body.project).toBe("default-cli-project");
    expect(body.model).toBe("gemini-3.6-flash-high");
    expect(body.requestType).toBe("agent");
    expect(body.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M71");
    expect(body.request.labels.trajectory_id).toBe("deadbeef");

    // system 是 systemInstruction，不是一条 content
    expect(body.request.systemInstruction).toEqual({ role: "user", parts: [{ text: "you are a gateway\n\nbe terse" }] });

    // 角色是 user/model；并行两个 functionCall 在同一条 model content 里
    expect(body.request.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    const modelParts = body.request.contents[1].parts;
    expect(modelParts[0]).toEqual({ text: "on it" });
    expect(modelParts[1].functionCall).toEqual({ id: "call_a", name: "glob", args: { path: "**/*" } });
    expect(modelParts[2].functionCall.id).toBe("call_b");
    // 没见过签名 → 占位符（并记 loss）
    expect(modelParts[1].thoughtSignature).toBe("skip_thought_signature_validator");

    // 工具结果按 id 关联落成 functionResponse，name 从历史调用里补回来
    const userParts = body.request.contents[2].parts;
    expect(userParts[0].functionResponse).toEqual({ id: "call_a", name: "glob", response: { result: "a.txt\nb.txt" } });
    expect(userParts[1].functionResponse.response).toEqual({ error: "boom" });
    expect(userParts[2]).toEqual({ inlineData: { mimeType: "image/png", data: "iVBORw0K" } });

    // 工具声明：schema 清洗成 Gemini 子集，联合类型退化成 nullable
    const declarations = body.request.tools[0].functionDeclarations;
    expect(declarations.map((d: any) => d.name)).toEqual(["glob", "read"]);
    expect(declarations[0].parameters).toEqual({
      type: "OBJECT",
      properties: { path: { type: "STRING" }, hidden: { nullable: true, type: "BOOLEAN" } },
      required: ["path"],
    });
    expect(body.request.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: ["glob"] });

    // schema 丢键必须留痕
    expect(result.losses.some((loss) =>
      loss.path === "$.conversation.toolset.tools[0]" && loss.detail.includes("$schema"))).toBe(true);
  });

  it("不支持/有损的能力各记一条 loss，且路径指到位", async () => {
    clearThoughtSignatureCache();
    const toolset: IRToolset = {
      tools: [
        { kind: "freeform", ref: { group: null, name: "apply_patch" }, description: "patch" },
        { kind: "builtin", ref: { group: null, name: "web_search" }, builtin: "web_search_20250305" },
        { kind: "function", ref: { group: "mcp", name: "search" }, description: "s", schema: { type: "object", properties: {} } },
      ],
      groups: [{ name: "mcp", members: ["search"] }],
      choice: defaultValue({ kind: "auto" }),
      parallel: clientValue(false),
    };
    const result = await compiled(request({
      system: [{ kind: "text", text: "sys", cacheBreakpoint: { scope: "ephemeral" } }],
      toolset,
      turns: [
        { role: "user", parts: [{ kind: "image", media: { source: { kind: "url", url: "https://x/y.png" }, mediaType: "image/png" } }] },
        {
          role: "assistant",
          parts: [
            { kind: "thinking", text: "hmm", signature: "anthropic-sig" },
            { kind: "redactedThinking", data: "zzz" },
            { kind: "opaque", origin: "openai_responses", tag: "web_search_call", raw: { type: "web_search_call" } },
            { kind: "toolCall", call: { id: "call_shot", toolRef: { group: null, name: "screenshot" }, input: { kind: "json", value: {} } } },
          ],
        },
        {
          role: "user",
          parts: [
            { kind: "toolResult", result: { callId: "call_shot", parts: [{ kind: "image", media: { source: { kind: "base64", data: "AAA" }, mediaType: "image/jpeg" } }], status: "ok" } },
          ],
        },
      ],
      intent: intent({
        reasoning: clientValue({ mode: "enabled", effort: "high", budgetTokens: 2048, display: "summarized" }),
        sampling: { topK: clientValue(40), temperature: clientValue(0.2) },
        // 6144 = thinkingBudget(2048) + 正文最低额度(4096)：给得下去，才轮得到「留痕」这条路。
        stopping: { maxOutputTokens: clientValue(6144) },
        contextEdits: [{ kind: "clearThinking", keep: "all", raw: { type: "clear_thinking_20251015" } }],
        serviceTier: clientValue("priority"),
        stream: clientValue(false),
        outputFormat: clientValue({ kind: "jsonSchema", schema: { type: "object" } }),
      }),
    }));

    const details = result.losses.map((loss) => `${loss.path} :: ${loss.kind} :: ${loss.detail}`);
    const has = (fragment: string): boolean => details.some((detail) => detail.includes(fragment));

    expect(has("cachedContent")).toBe(true);                       // cacheBreakpoint
    expect(has("File API/fileData")).toBe(true);                   // url 图片
    expect(has("无 thinking part 通道")).toBe(true);                // 历史思考
    expect(has("thinking.signature 亦无对应字段")).toBe(true);       // Anthropic 签名
    expect(has("redacted_thinking")).toBe(true);
    expect(has("opaque part from openai_responses")).toBe(true);
    expect(has("builtin 工具")).toBe(true);
    expect(has("freeform 工具")).toBe(true);
    expect(has("tool group 'mcp'")).toBe(true);
    expect(has("模型是否真按图片解读未经实测")).toBe(true);           // toolResultImage
    expect(has("关闭并行调用")).toBe(true);
    expect(has("generationConfig.topK")).toBe(true);
    expect(has("responseMimeType/responseSchema")).toBe(true);      // structuredOutput
    expect(has("上下文编辑指令")).toBe(true);
    expect(has("服务档位")).toBe(true);
    expect(has("streamGenerateContent")).toBe(true);                // 非流式
    const body = JSON.parse(result.wire.body) as Record<string, any>;
    // 客户端明确给的额度照发，一个 token 都不替它改
    expect(body.request.generationConfig.maxOutputTokens).toBe(6144);
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
    expect(body.request.generationConfig.topK).toBeUndefined();
    // url 图片那条 user 被清空 → 不进 contents；assistant 只剩工具调用
    expect(body.request.contents.map((content: any) => content.role)).toEqual(["model", "user"]);
    expect(body.request.contents[1].parts[0].functionResponse.name).toBe("screenshot");
    // builtin 被丢掉，剩下两个声明
    expect(body.request.tools[0].functionDeclarations.map((d: any) => d.name)).toEqual(["apply_patch", "mcp__search"]);
  });

  // 旧行为：孤儿结果的 functionResponse.name 填成 'tool'。那个名字是上游用来找函数声明的，
  // 编一个等于把「结果对不上调用」伪装成一次正常回传。
  it("孤儿工具结果拒绝，不再把 functionResponse.name 编成 'tool'", async () => {
    clearThoughtSignatureCache();
    const { problems } = await rejected(request({
      turns: [
        { role: "user", parts: [{ kind: "text", text: "go" }] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "ghost", parts: [{ kind: "text", text: "x" }], status: "ok" } },
        ] },
      ],
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("orphanToolResult");
    expect(problems[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(problems[0]?.detail).toContain("ghost");
    expect(problems[0]?.detail).toContain("dropOrphanToolResult");
  });

  // 旧行为：客户端给的 max_tokens 小于思考预算时**擅自抬高**。抬高是在推翻客户端明确写下的
  // 成本上限；不抬则上游返回 200 但正文全空。两条路都不能默默走，只能拒绝。
  it("max_tokens 被思考预算吃光时拒绝，不再擅自抬高；多个问题一次全收集", async () => {
    clearThoughtSignatureCache();
    const { problems, losses } = await rejected(request({
      turns: [
        { role: "user", parts: [{ kind: "text", text: "go" }] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "ghost", parts: [{ kind: "text", text: "x" }], status: "ok" } },
        ] },
      ],
      intent: intent({
        reasoning: clientValue({ mode: "enabled", budgetTokens: 10000, display: "summarized" }),
        sampling: { topK: clientValue(40) },
        stopping: { maxOutputTokens: clientValue(20) },
      }),
    }));
    expect(problems.map((problem) => problem.kind).sort()).toEqual(["orphanToolResult", "unsatisfiableValue"]);

    // kind 是 `unsatisfiableValue` 不是 `requiredFieldMissing`：maxOutputTokens 与
    // thinkingBudget **都在**，无解的是两者的组合。分错 kind 会把调用方指向「补一个值」，
    // 而这里要改的是已经存在的那个值（或与它冲突的那个字段）。
    const ceiling = problems.find((problem) => problem.kind === "unsatisfiableValue");
    expect(ceiling?.path).toBe("$.intent.stopping.maxOutputTokens");
    // detail 必须同时给出**冲突双方与下界**，否则调用方不知道该把哪一边改到多少
    expect(ceiling?.detail).toContain("thinkingBudget(10000)");   // 冲突的另一方
    expect(ceiling?.detail).toContain("20");                      // 客户端给的值
    expect(ceiling?.detail).toContain("14096");                   // 这条 wire 的下界
    expect(problems.some((problem) => problem.kind === "requiredFieldMissing")).toBe(false);
    // 拒绝前记下的有损条目照样交出
    expect(losses.some((loss) => loss.path === "$.intent.sampling.topK")).toBe(true);
  });

  it("空工具结果拒绝：以前 status='missing' 会被补一句网关自己写的正文", async () => {
    clearThoughtSignatureCache();
    const { problems } = await rejected(request({
      turns: [
        { role: "assistant", parts: [
          { kind: "toolCall", call: { id: "call_e", toolRef: { group: null, name: "bash" }, input: { kind: "json", value: {} } } },
        ] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "call_e", parts: [], status: "missing" } },
        ] },
      ],
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe("requiredFieldMissing");
    expect(problems[0]?.path).toBe("$.conversation.turns[1].parts[0]");
    expect(problems[0]?.detail).toContain("fillEmptyToolResult");
  });

  it("客户端没给 max_tokens 时不补默认值：generationConfig 里根本没有这个键", async () => {
    clearThoughtSignatureCache();
    const result = await compiled(request({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    }));
    const body = JSON.parse(result.wire.body) as Record<string, any>;
    expect("maxOutputTokens" in body.request.generationConfig).toBe(false);
    expect(result.losses).toEqual([]);
  });

  it("正常请求 ok:true，wire 逐字段锁死", async () => {
    clearThoughtSignatureCache();
    const result = await compiled(request({
      system: [{ kind: "text", text: "sys" }],
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: intent({ stopping: { maxOutputTokens: clientValue(1024) } }),
    }));
    expect(result.wire.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(result.wire.method).toBe("POST");
    expect(result.wire.headers).toEqual({
      authorization: "Bearer ya29.test-token",
      "content-type": "application/json",
      accept: "text/event-stream",
      "cache-control": "no-cache",
      "user-agent": "antigravity/fantasy/1.0.0 linux/amd64",
    });
    expect(JSON.parse(result.wire.body)).toEqual({
      project: "default-cli-project",
      requestId: "agent/1785856733829/1785856733829/deadbeef/2",
      model: "gemini-3.6-flash-high",
      userAgent: "antigravity",
      requestType: "agent",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        sessionId: "1785856733829",
        systemInstruction: { role: "user", parts: [{ text: "sys" }] },
        generationConfig: {
          maxOutputTokens: 1024,
          thinkingConfig: { includeThoughts: true },
        },
        labels: {
          used_claude: "false",
          used_claude_conservative: "false",
          trajectory_id: "deadbeef",
          last_step_index: "0",
          model_enum: "MODEL_PLACEHOLDER_M71",
        },
      },
    });
    expect(result.losses).toEqual([]);
  });

  it("确定性：同一个 IR 连续构造两次，body 字节完全相同", async () => {
    clearThoughtSignatureCache();
    const fixture = request({
      system: [{ kind: "text", text: "sys" }],
      turns: [
        { role: "user", parts: [{ kind: "text", text: "hi" }] },
        { role: "assistant", parts: [
          { kind: "toolCall", call: { id: "call_d", toolRef: { group: null, name: "glob" }, input: { kind: "json", value: { path: "**/*" } } } },
        ] },
        { role: "user", parts: [
          { kind: "toolResult", result: { callId: "call_d", parts: [{ kind: "text", text: "a.txt" }], status: "ok" } },
        ] },
      ],
      intent: intent({ stopping: { maxOutputTokens: clientValue(1024) } }),
    });
    const first = await compiled(fixture);
    const second = await compiled(fixture);
    expect(second.wire.body).toBe(first.wire.body);
    expect(second.wire).toEqual(first.wire);
    expect(second.losses).toEqual(first.losses);
  });

  it("effort 在这里换算成 thinkingBudget（IR 不在 ingress 互转），并留痕", async () => {
    const result = await compiled(request({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: intent({ reasoning: clientValue({ mode: "enabled", effort: "high", display: "summarized" }) }),
    }));
    const body = JSON.parse(result.wire.body) as Record<string, any>;
    expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(10000);
    expect(result.losses.some((loss) =>
      loss.path === "$.intent.reasoning.effort" && loss.kind === "substituted")).toBe(true);
  });

  it("display:'hidden' 关掉 includeThoughts，不产出 thought part", async () => {
    const result = await compiled(request({
      turns: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      intent: intent({ reasoning: clientValue({ mode: "enabled", budgetTokens: 1000, display: "hidden" }) }),
    }));
    const body = JSON.parse(result.wire.body) as Record<string, any>;
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: false, thinkingBudget: 1000 });
  });
});

// ── lift ────────────────────────────────────────────────────────────────────

describe("lift：v1internal SSE → IREvent", () => {
  it("正常文本流：思考累加 + 正文累加 + finishReason 终止 + usage", async () => {
    const events = await collect(egress.readUpstreamResponse(sse(REAL_TEXT_STREAM)));
    const kinds = events.map((event) => event.kind);

    expect(events[0]).toEqual({ kind: "messageStart", model: "gemini-3.6-flash" });
    // 没有 content_block_start：思考块与文本块的边界是本出口按「种类切换」合成的
    expect(kinds.filter((kind) => kind === "partStart")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "partEnd")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });

    const assembled = await assembleResponse(egress.readUpstreamResponse(sse(REAL_TEXT_STREAM)), "fallback");
    expect(assembled.model).toBe("gemini-3.6-flash");
    expect(assembled.turn.parts).toEqual([
      { kind: "thinking", text: "**Focusing on Precision**\n\n**Analyzing Conflicting Directives**\n\n" },
      { kind: "text", text: "OK喵" },
    ]);
    expect(assembled.stopReason).toBe("endTurn");
    // promptTokenCount 含缓存；cloudcode 从不带 cachedContentTokenCount → 三态里的 undefined
    expect(assembled.usage).toEqual({ inputTokens: 26489, outputTokens: 2, reasoningTokens: 1180 });
    expect(assembled.usage?.cacheReadTokens).toBeUndefined();
  });

  it("functionCall：args 整包到达，仍要发 toolInputJson delta（chat 流式 encoder 只读 delta）", async () => {
    clearThoughtSignatureCache();
    const events = await collect(egress.readUpstreamResponse(sse(REAL_TOOL_STREAM)));
    const start = events.find((event) => event.kind === "partStart");
    expect(start).toEqual({
      kind: "partStart",
      index: 0,
      part: { kind: "toolCall", call: { id: "cKU4A4Y3", toolRef: { group: null, name: "glob" }, input: { kind: "json", value: {} } } },
    });
    const delta = events.find((event) => event.kind === "partDelta");
    expect(delta).toEqual({
      kind: "partDelta", index: 0,
      delta: { kind: "toolInputJson", json: JSON.stringify({ i: "Searching for files in current directory", hidden: true, gitignore: false, path: "**/*" }) },
    });
    // STOP + 出过工具调用 → toolUse（Gemini 没有独立的 tool_use 终止码，这是推断）
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "toolUse" });

    const assembled = await assembleResponse(egress.readUpstreamResponse(sse(REAL_TOOL_STREAM)), "fallback");
    expect(assembled.turn.parts).toEqual([{
      kind: "toolCall",
      call: {
        id: "cKU4A4Y3",
        toolRef: { group: null, name: "glob" },
        input: { kind: "json", value: { i: "Searching for files in current directory", hidden: true, gitignore: false, path: "**/*" } },
      },
    }]);
    expect(assembled.stopReason).toBe("toolUse");
  });

  it("thoughtSignature 记一条 loss（IR 没有承载它的位置），并按 call id 回填到下一轮", async () => {
    clearThoughtSignatureCache();
    const events = await collect(egress.readUpstreamResponse(sse(REAL_TOOL_STREAM)));
    const losses = events.filter((event) => event.kind === "loss");
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ kind: "loss", loss: { stage: "lift", kind: "dropped" } });

    // 下一轮把同一个 call id 送回来：占位符被真实签名替换，且不再记「没有签名」的 loss
    const next = await compiled(request({
      turns: [
        { role: "user", parts: [{ kind: "text", text: "list" }] },
        { role: "assistant", parts: [{ kind: "toolCall", call: { id: "cKU4A4Y3", toolRef: { group: null, name: "glob" }, input: { kind: "json", value: {} } } }] },
      ],
    }));
    const body = JSON.parse(next.wire.body) as Record<string, any>;
    expect(body.request.contents[1].parts[0].thoughtSignature).toBe(REAL_SIG_FUNCTION_CALL);
    expect(next.losses.some((loss) => loss.detail.includes("skip_thought_signature_validator"))).toBe(false);
  });

  it("未知 chunk 形态 → unhandled，不静默吞掉", async () => {
    const events = await collect(egress.readUpstreamResponse(sse([
      { response: { somethingBrandNew: 1 }, traceId: "t" },
      "not json at all",
      REAL_TEXT_STREAM[4],
    ])));
    const unhandled = events.filter((event) => event.kind === "unhandled");
    expect(unhandled).toHaveLength(2);
    expect(unhandled[0]).toMatchObject({ rawType: "<gemini-chunk>" });
  });

  it("未知 part 形态（inlineData 等新增输出）→ unhandled，rawType 带键集", async () => {
    const events = await collect(egress.readUpstreamResponse(sse([
      {
        response: {
          candidates: [{
            content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 },
          modelVersion: "gemini-3.1-flash-image",
        },
      },
    ])));
    const unhandled = events.find((event) => event.kind === "unhandled");
    expect(unhandled).toMatchObject({ kind: "unhandled", rawType: "<gemini-part:inlineData>" });
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });
  });

  it("多 candidate → loss（IR 的响应只有一个回合）", async () => {
    const events = await collect(egress.readUpstreamResponse(sse([
      {
        response: {
          candidates: [
            { content: { role: "model", parts: [{ text: "a" }] }, finishReason: "STOP" },
            { content: { role: "model", parts: [{ text: "b" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          modelVersion: "gemini-3.6-flash",
        },
      },
    ])));
    expect(events.some((event) => event.kind === "loss" && event.loss.path === "$.response.candidates")).toBe(true);
    const assembled = await assembleResponse(egress.readUpstreamResponse(sse([
      {
        response: {
          candidates: [
            { content: { role: "model", parts: [{ text: "a" }] }, finishReason: "STOP" },
            { content: { role: "model", parts: [{ text: "b" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          modelVersion: "gemini-3.6-flash",
        },
      },
    ])), "fallback");
    expect(assembled.turn.parts).toEqual([{ kind: "text", text: "a" }]);
  });

  it("流结束却没等到任何 finishReason → error，不是安静的空成功", async () => {
    const truncated = REAL_TEXT_STREAM.slice(0, 3);
    const events = await collect(egress.readUpstreamResponse(sse(truncated)));
    expect(events.at(-1)).toEqual({
      kind: "error",
      error: {
        kind: "transport", httpStatus: null, retryable: true,
        message: "upstream stream ended without a finishReason; the turn is truncated",
        raw: null,
      },
    });
    expect(events.some((event) => event.kind === "messageStop")).toBe(false);

    const assembled = await assembleResponse(egress.readUpstreamResponse(sse(truncated)), "fallback");
    expect(assembled.stopReason).toBeNull();
    expect(assembled.error?.kind).toBe("transport");
    // 内容还在，但结局是 error —— 调用方分得清截断与真结束
    expect(assembled.turn.parts).toHaveLength(2);
  });

  it("MAX_TOKENS / 内容策略 / MALFORMED_FUNCTION_CALL 各自终止得不一样", async () => {
    const chunk = (finishReason: string): unknown => ({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason }],
        usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 1, totalTokenCount: 107, thoughtsTokenCount: 47 },
        modelVersion: "gemini-default",
      },
    });
    expect((await collect(egress.readUpstreamResponse(sse([chunk("MAX_TOKENS")])))).at(-1)).toEqual({ kind: "messageStop", reason: "maxTokens" });
    expect((await collect(egress.readUpstreamResponse(sse([chunk("SAFETY")])))).at(-1)).toEqual({ kind: "messageStop", reason: "refusal" });
    // 工具调用写坏了：既没有合法 functionCall 也没有正文，报成 endTurn 会变成静默空回合
    const malformed = (await collect(egress.readUpstreamResponse(sse([chunk("MALFORMED_FUNCTION_CALL")])))).at(-1);
    expect(malformed).toMatchObject({ kind: "error", error: { kind: "unknown", retryable: true } });
  });

  it("promptFeedback.blockReason → contentPolicy 且不可重试", async () => {
    const events = await collect(egress.readUpstreamResponse(sse([
      { response: { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 }, modelVersion: "gemini-3.6-flash" } },
    ])));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "contentPolicy", retryable: false } });
  });

  it("4xx/5xx → 正确的 kind 与 retryable", async () => {
    const google = (code: number, status: string, message: string): Response =>
      new Response(JSON.stringify({ error: { code, message, status } }), {
        status: code, headers: { "content-type": "application/json" },
      });

    const cases: ReadonlyArray<[Response, string, boolean]> = [
      [google(400, "INVALID_ARGUMENT", "Request contains an invalid argument."), "invalidRequest", false],
      [google(400, "INVALID_ARGUMENT", "The input token count (1200000) exceeds the maximum number of tokens allowed"), "contextLengthExceeded", false],
      [google(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."), "permissionDenied", false],
      [google(403, "PERMISSION_DENIED", "Permission denied on resource project."), "permissionDenied", false],
      [google(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)."), "quotaExhausted", false],
      [google(429, "RESOURCE_EXHAUSTED", "Too many requests, please retry."), "rateLimited", true],
      [google(500, "INTERNAL", "Internal error encountered."), "upstreamUnavailable", true],
      [google(503, "UNAVAILABLE", "The service is currently unavailable."), "upstreamUnavailable", true],
      [google(504, "DEADLINE_EXCEEDED", "Deadline expired before operation could complete."), "upstreamUnavailable", true],
    ];
    for (const [response, kind, retryable] of cases) {
      const events = await collect(egress.readUpstreamResponse(response));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "error", error: { kind, retryable } });
    }
  });

  it("流中直接塞 `{error}` 的 200 也要变成 error", async () => {
    const events = await collect(egress.readUpstreamResponse(sse([
      REAL_TEXT_STREAM[2],
      { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } },
    ])));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { kind: "quotaExhausted" } });
    // 已经开出去的块要收口，不能留一个永远不 close 的 content block
    expect(events.some((event) => event.kind === "partEnd")).toBe(true);
  });

  it("CRLF 帧分隔（cloudcode 实测就是 \\r\\n\\r\\n）必须切得开 —— 切不开就是整轮内容凭空消失", async () => {
    // 2026-08-04 真实打通 cloudcode-pa 抓到的字节形态：分隔符是 \r\n\r\n，
    // 而 src/ir/sse.ts 的 iterateSse 只找 "\n\n"，会把整条流攒成一个 block。
    const crlf = new Response(
      REAL_TEXT_STREAM.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const assembled = await assembleResponse(egress.readUpstreamResponse(crlf), "fallback");
    expect(assembled.unhandled).toEqual([]);
    expect(assembled.stopReason).toBe("endTurn");
    expect(assembled.turn.parts.at(-1)).toEqual({ kind: "text", text: "OK喵" });
  });

  it("跨 chunk 的残留缓冲：一帧被 TCP 切成三段也不能丢内容", async () => {
    const wire = REAL_TEXT_STREAM.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("");
    const encoder = new TextEncoder();
    const pieces: Uint8Array[] = [];
    for (let cut = 0; cut < wire.length; cut += 37) pieces.push(encoder.encode(wire.slice(cut, cut + 37)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });
    const assembled = await assembleResponse(
      egress.readUpstreamResponse(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })),
      "fallback",
    );
    expect(assembled.unhandled).toEqual([]);
    expect(assembled.turn.parts.at(-1)).toEqual({ kind: "text", text: "OK喵" });
  });

  it("非 SSE 的一次性 JSON 走同一条 chunk 处理，不长出第二条解析路径", async () => {
    const events = await collect(egress.readUpstreamResponse(new Response(JSON.stringify(REAL_TOOL_STREAM[1]), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    expect(events[0]).toMatchObject({ kind: "messageStart" });
    expect(events.at(-1)).toEqual({ kind: "messageStop", reason: "endTurn" });
  });
});
