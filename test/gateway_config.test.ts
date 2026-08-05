/**
 * 网关配置层。
 *
 * 这组测试盯住的是**启动期的确定性**：进程要么带着一条明确的路由起来，要么带着一条
 * 可执行的错误信息不起来。中间那种「起来了，但路由不是你以为的那条」是这一层要消灭的形态，
 * 所以每个 parse 都有三个用例：合法、非法（且错误信息列全合法值）、缺省。
 *
 * 枚举完整性一律不靠人肉核对：
 *   - 出口清单从 `OUTBOX_REGISTRY` 取，不在这里手抄第二份；
 *   - 每个出口的 env 夹具写成以 `OutboxName` 为键的映射类型 —— 注册表加一家而这里没给夹具，
 *     本文件当场编译失败；
 *   - problem → repair 映射两侧分别用 `IR_BUILD_PROBLEM_KINDS` 与 `IR_REPAIR_KINDS` 枚举核对。
 */
import { describe, expect, it } from "bun:test";
import type { AnthropicOutboxOptions } from "../src/egress/anthropic.ts";
import type { WindsurfOutboxOptions } from "../src/egress/windsurf/index.ts";
import { OUTBOX_VARIABLE, readGatewayRuntimeSettings } from "../src/gateway/config.ts";
import {
  OUTBOX_SELECTIONS, OUTBOX_NAMES,
  type OutboxBodyOf, type OutboxName, type OutboxOptionsOf,
} from "../src/gateway/outbox_selection.ts";
import { GatewaySettingsError, type EnvLookup } from "../src/gateway/env.ts";
import {
  describeUnroutedModel, readModelRoutingTable, resolveOutboxModel,
} from "../src/gateway/model_routing.ts";
import {
  REPAIRS_FOR_PROBLEM_KIND, REPAIR_KINDS_VARIABLE, describeProblemWithRepairAdvice,
} from "../src/gateway/repair_advice.ts";
import { DEFAULT_STREAM_POLICY } from "../src/ir/stream_guard.ts";
import { IR_BUILD_PROBLEM_KINDS, type IRBuildProblem } from "../src/ir/types.ts";
import { OUTBOX_REGISTRY } from "../src/protocols.ts";
import { IR_REPAIR_KINDS, type IRRepairKind } from "../src/repair/index.ts";

// ── 类型层断言工具 ──────────────────────────────────────────────────────────

/** 严格相等（不是互相 extends）：把 `any` 与联合坍缩都挡在外面。 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * 每个出口的最小可用环境。**键由 `OutboxName` 穷举**：注册表加一家而这里漏给夹具，
 * 这份赋值当场编译失败 —— 新出口不可能悄悄地「没人测过配置」就上线。
 */
const OUTBOX_FIXTURES: Readonly<Record<OutboxName, {
  readonly env: EnvLookup;
  /**
   * 一个变量都不给时能不能 bind 成功。
   * gemini 是唯一的 true：它的凭据有既定的默认来源（`~/.gemini/oauth_creds.json`），
   * 缺失会在第一次取 token 时带路径报错，而不是启动期。这条被显式写下来，
   * 免得哪天它变成 false 而没人发现。
   */
  readonly bindsWithoutEnv: boolean;
  readonly outbox: OutboxName;
}>> = {
  copilot: {
    env: {
      AGENT_IR_COPILOT_API_BASE: "https://api.individual.githubcopilot.com",
      AGENT_IR_COPILOT_SESSION_TOKEN: "tid=test",
      AGENT_IR_COPILOT_GITHUB_TOKEN: "gho_test",
    },
    bindsWithoutEnv: false,
    outbox: "copilot",
  },

  anthropic: {
    env: {
      AGENT_IR_ANTHROPIC_BASE_URL: "https://example.invalid",
      AGENT_IR_ANTHROPIC_API_KEY: "sk-test",
    },
    bindsWithoutEnv: false,
    outbox: "anthropic",
  },
  openai_chat: {
    env: {
      AGENT_IR_OPENAI_CHAT_BASE_URL: "https://example.invalid",
      AGENT_IR_OPENAI_CHAT_API_KEY: "sk-test",
    },
    bindsWithoutEnv: false,
    outbox: "openai_chat",
  },
  openai_responses: {
    env: {
      AGENT_IR_OPENAI_RESPONSES_BASE_URL: "https://example.invalid",
      AGENT_IR_OPENAI_RESPONSES_API_KEY: "sk-test",
    },
    bindsWithoutEnv: false,
    outbox: "openai_responses",
  },
  gemini_cloudcode: {
    env: {
      AGENT_IR_GEMINI_CLOUDCODE_ACCESS_TOKEN: "ya29.test",
      AGENT_IR_GEMINI_CLOUDCODE_PROJECT: "default-cli-project",
    },
    bindsWithoutEnv: true,
    outbox: "gemini_cloudcode",
  },
  windsurf: {
    env: { AGENT_IR_WINDSURF_API_KEY: "devin-session-token$test" },
    bindsWithoutEnv: false,
    outbox: "windsurf",
  },
};

function envFor(name: OutboxName, extra: EnvLookup = {}): EnvLookup {
  return { [OUTBOX_VARIABLE]: name, ...OUTBOX_FIXTURES[name].env, ...extra };
}

// ── 出口选择 ────────────────────────────────────────────────────────────────

describe("出口按配置选，选不中就不起", () => {
  it("合法出口名各起一次，profile 与注册表对得上", () => {
    for (const name of OUTBOX_NAMES) {
      const config = readGatewayRuntimeSettings(envFor(name));
      expect(config.outbox.name).toBe(name);
      expect(config.outbox.wire).toBe(OUTBOX_REGISTRY[name].wire);
      expect(config.outbox.resolve("outbox-model-id")).toBeDefined();
      expect(config.outbox.name).toBe(OUTBOX_FIXTURES[name].outbox);
    }
  });

  it("出口名拼错：启动失败，且把全部合法值列出来", () => {
    let thrown: unknown;
    try { readGatewayRuntimeSettings({ [OUTBOX_VARIABLE]: "anthropi" }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GatewaySettingsError);
    const message = (thrown as Error).message;
    expect(message).toContain("anthropi");
    // 「列出全部合法值」不是列一部分：逐个断言，漏一个就失败。
    for (const name of OUTBOX_NAMES) expect(message).toContain(name);
  });

  it("出口名缺省：没有默认出口，必须显式选", () => {
    expect(() => readGatewayRuntimeSettings({})).toThrow(GatewaySettingsError);
    let thrown: unknown;
    try { readGatewayRuntimeSettings({}); } catch (error) { thrown = error; }
    const message = (thrown as Error).message;
    expect(message).toContain(OUTBOX_VARIABLE);
    for (const name of OUTBOX_NAMES) expect(message).toContain(name);
  });

  it("必填变量缺失：启动期就抛，且点名是哪个变量", () => {
    for (const name of OUTBOX_NAMES) {
      const fixture = OUTBOX_FIXTURES[name];
      if (fixture.bindsWithoutEnv) {
        expect(() => readGatewayRuntimeSettings({ [OUTBOX_VARIABLE]: name })).not.toThrow();
        continue;
      }
      let thrown: unknown;
      try { readGatewayRuntimeSettings({ [OUTBOX_VARIABLE]: name }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(GatewaySettingsError);
      // 变量名以注册表键机械派生，所以错误信息里一定带这个前缀。
      expect((thrown as Error).message).toContain(`AGENT_IR_${name.toUpperCase()}_`);
    }
  });

  it("同一个上游模型 id 只造一次出口实例，不同 id 各造各的", () => {
    const config = readGatewayRuntimeSettings(envFor("anthropic"));
    const first = config.outbox.resolve("model-a");
    expect(config.outbox.resolve("model-a")).toBe(first);
    expect(config.outbox.resolve("model-b")).not.toBe(first);
  });

  it("配置表的键与注册表的键完全一致，且每一行绑的是同名那一家", () => {
    expect(Object.keys(OUTBOX_SELECTIONS).sort()).toEqual(Object.keys(OUTBOX_REGISTRY).sort());
    for (const name of OUTBOX_NAMES) {
      expect(OUTBOX_SELECTIONS[name].name).toBe(name);
      expect(OUTBOX_SELECTIONS[name].wire).toBe(OUTBOX_REGISTRY[name].wire);
    }
  });

  it("「按选中出口取对应 options / body」在类型层成立", () => {
    // 写错任何一条，这个文件编译不过 —— 断言发生在 tsc，不在 expect。
    const anthropicOptions: Equal<OutboxOptionsOf<"anthropic">, AnthropicOutboxOptions> = true;
    const windsurfOptions: Equal<OutboxOptionsOf<"windsurf">, WindsurfOutboxOptions> = true;
    // body 泛型没有被抹平成 string：windsurf 的 wire body 是字节。
    const windsurfBody: Equal<OutboxBodyOf<"windsurf">, Uint8Array> = true;
    const anthropicBody: Equal<OutboxBodyOf<"anthropic">, string> = true;
    expect([anthropicOptions, windsurfOptions, windsurfBody, anthropicBody]).toEqual([true, true, true, true]);
  });
});

// ── 修复开关 ────────────────────────────────────────────────────────────────

describe("修复种类是名单，不是布尔", () => {
  it("缺省：一条都不修", () => {
    const config = readGatewayRuntimeSettings(envFor("anthropic"));
    expect(config.repairKinds).toEqual([]);
    expect(Object.keys(config.repairPolicy)).toEqual([]);
  });

  it("合法名单：逐条进策略，且键存在即启用（没有 enabled 布尔）", () => {
    const config = readGatewayRuntimeSettings(envFor("anthropic", {
      [REPAIR_KINDS_VARIABLE]: "defaultMaxOutputTokens, fillDanglingToolCall",
    }));
    expect(config.repairKinds).toEqual(["defaultMaxOutputTokens", "fillDanglingToolCall"]);
    expect(config.repairPolicy.defaultMaxOutputTokens).toEqual({});
    expect(config.repairPolicy.fillDanglingToolCall).toEqual({});
    expect(config.repairPolicy.dropOrphanToolResult).toBeUndefined();
  });

  it("全部合法种类都能被名单接受", () => {
    const config = readGatewayRuntimeSettings(envFor("anthropic", {
      [REPAIR_KINDS_VARIABLE]: IR_REPAIR_KINDS.join(","),
    }));
    expect([...config.repairKinds].sort()).toEqual([...IR_REPAIR_KINDS].sort());
  });

  it("种类拼错：启动失败，且把全部合法值列出来", () => {
    let thrown: unknown;
    try {
      readGatewayRuntimeSettings(envFor("anthropic", { [REPAIR_KINDS_VARIABLE]: "defaultMaxTokens" }));
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(GatewaySettingsError);
    const message = (thrown as Error).message;
    expect(message).toContain("defaultMaxTokens");
    for (const kind of IR_REPAIR_KINDS) expect(message).toContain(kind);
  });

  it("同一种类重复登记：失败而不是静默去重", () => {
    expect(() => readGatewayRuntimeSettings(envFor("anthropic", {
      [REPAIR_KINDS_VARIABLE]: "dropEmptyTurn,dropEmptyTurn",
    }))).toThrow(GatewaySettingsError);
  });
});

// ── 模型映射 ────────────────────────────────────────────────────────────────

describe("模型映射：客户端名 → 上游 id", () => {
  it("命中表：走表里那条", () => {
    const table = readModelRoutingTable({ AGENT_IR_MODEL_MAP: "claude-opus-5=upstream-opus,gpt-5=upstream-gpt" });
    expect(resolveOutboxModel(table, "claude-opus-5"))
      .toEqual({ kind: "routed", outboxModel: "upstream-opus", via: "table" });
    expect(resolveOutboxModel(table, "gpt-5"))
      .toEqual({ kind: "routed", outboxModel: "upstream-gpt", via: "table" });
  });

  it("不中且未配兜底：拒绝，并把已登记的客户端模型列出来", () => {
    const table = readModelRoutingTable({ AGENT_IR_MODEL_MAP: "claude-opus-5=upstream-opus" });
    const resolution = resolveOutboxModel(table, "claude-sonnet-9");
    expect(resolution.kind).toBe("unrouted");
    if (resolution.kind !== "unrouted") throw new Error("unreachable");
    expect(resolution.knownClientModels).toEqual(["claude-opus-5"]);
    const message = describeUnroutedModel(resolution);
    expect(message).toContain("claude-sonnet-9");
    expect(message).toContain("claude-opus-5");
    expect(message).toContain("AGENT_IR_MODEL_MAP");
    expect(message).toContain("AGENT_IR_MODEL_FALLBACK");
  });

  it("兜底 passthrough：原样透传，且透传这件事在结果里留痕", () => {
    const table = readModelRoutingTable({ AGENT_IR_MODEL_FALLBACK: "passthrough" });
    expect(resolveOutboxModel(table, "whatever"))
      .toEqual({ kind: "routed", outboxModel: "whatever", via: "passthrough" });
  });

  it("兜底 pinned：统一落到一个上游 id", () => {
    const table = readModelRoutingTable({ AGENT_IR_MODEL_FALLBACK: "pinned:upstream-only" });
    expect(resolveOutboxModel(table, "whatever"))
      .toEqual({ kind: "routed", outboxModel: "upstream-only", via: "pinned" });
  });

  it("缺省：空表 + refuse", () => {
    const table = readModelRoutingTable({});
    expect(table.routes.size).toBe(0);
    expect(table.fallback).toEqual({ kind: "refuse" });
    expect(resolveOutboxModel(table, "anything").kind).toBe("unrouted");
  });

  it("非法配置一律启动失败", () => {
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_MAP: "no-separator" })).toThrow(GatewaySettingsError);
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_MAP: "=upstream" })).toThrow(GatewaySettingsError);
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_MAP: "client=" })).toThrow(GatewaySettingsError);
    // 同一个客户端名两条冲突登记：静默取一个等于替写表的人挑了一个。
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_MAP: "a=x,a=y" })).toThrow(GatewaySettingsError);
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_FALLBACK: "whatever" })).toThrow(GatewaySettingsError);
    expect(() => readModelRoutingTable({ AGENT_IR_MODEL_FALLBACK: "pinned:" })).toThrow(GatewaySettingsError);
  });
});

// ── 流守卫策略 ──────────────────────────────────────────────────────────────

describe("流守卫策略可配，但默认就是生产标定值", () => {
  it("缺省：逐字段等于 DEFAULT_STREAM_POLICY", () => {
    expect(readGatewayRuntimeSettings(envFor("anthropic")).streamPolicy).toEqual(DEFAULT_STREAM_POLICY);
  });

  it("逐字段覆盖", () => {
    const config = readGatewayRuntimeSettings(envFor("anthropic", {
      AGENT_IR_STREAM_PRECOMMIT_TOTAL_MS: "30000",
      AGENT_IR_STREAM_PRECOMMIT_IDLE_MS: "12000",
      AGENT_IR_STREAM_POSTCOMMIT_IDLE_MS: "90000",
      AGENT_IR_STREAM_HEARTBEAT_MS: "3000",
    }));
    expect(config.streamPolicy).toEqual({
      precommitTotalMs: 30_000, precommitIdleMs: 12_000,
      postcommitIdleMs: 90_000, heartbeatMs: 3_000,
    });
  });

  it("提交后静默上限可以显式关掉，且 'none' 与 0 不是一回事", () => {
    const off = readGatewayRuntimeSettings(envFor("anthropic", { AGENT_IR_STREAM_POSTCOMMIT_IDLE_MS: "none" }));
    expect(off.streamPolicy.postcommitIdleMs).toBeNull();
    expect(() => readGatewayRuntimeSettings(envFor("anthropic", { AGENT_IR_STREAM_POSTCOMMIT_IDLE_MS: "0" })))
      .toThrow(GatewaySettingsError);
  });

  it("非整数 / 非正数一律失败", () => {
    expect(() => readGatewayRuntimeSettings(envFor("anthropic", { AGENT_IR_STREAM_HEARTBEAT_MS: "5s" })))
      .toThrow(GatewaySettingsError);
    expect(() => readGatewayRuntimeSettings(envFor("anthropic", { AGENT_IR_PORT: "-1" })))
      .toThrow(GatewaySettingsError);
  });
});

// ── problem → repair 映射的穷举性 ───────────────────────────────────────────

describe("problem kind → repair kind 映射是穷举的", () => {
  it("键恰好是 Core 的全部 problem kind，一个不多一个不少", () => {
    // Core 新增一种 problem kind，`Record<IRBuildProblemKind, …>` 会先编译失败；
    // 这条测试兜住的是「运行时两侧真的对得上」，包括拼写。
    expect(Object.keys(REPAIRS_FOR_PROBLEM_KIND).sort()).toEqual([...IR_BUILD_PROBLEM_KINDS].sort());
  });

  it("每条建议都是真实存在的 repair kind，且同一条不重复出现", () => {
    for (const problemKind of IR_BUILD_PROBLEM_KINDS) {
      const suggestions = REPAIRS_FOR_PROBLEM_KIND[problemKind];
      expect(new Set(suggestions).size).toBe(suggestions.length);
      for (const repairKind of suggestions) {
        expect(IR_REPAIR_KINDS).toContain(repairKind);
      }
    }
  });

  it("反方向不要求全覆盖，但「没被任何 problem 引用的修复」必须是这几条", () => {
    const referenced = new Set<IRRepairKind>(
      IR_BUILD_PROBLEM_KINDS.flatMap((kind) => [...REPAIRS_FOR_PROBLEM_KIND[kind]]));
    const unreferenced = IR_REPAIR_KINDS.filter((kind) => !referenced.has(kind));
    // 这两条修的是「准入过不去」与「相邻同角色回合」这类形状问题，不由 IRBuildProblem 报出来。
    // 名单变了就在这里失败 —— 逼人回答「新的那条到底修哪种 problem」，而不是默默漂移。
    expect([...unreferenced].sort()).toEqual(["dropEmptyTurn", "mergeAdjacentTurns"]);
  });

  it("拒绝信息按处境给出三种不同的可执行建议", () => {
    const problem = (kind: IRBuildProblem["kind"]): IRBuildProblem =>
      ({ kind, path: "$.intent.stopping.maxOutputTokens", detail: "detail text" });

    // 一、有候选且没开：说清楚开哪条。
    const advise = describeProblemWithRepairAdvice(problem("requiredFieldMissing"), new Set());
    expect(advise).toContain("requiredFieldMissing at $.intent.stopping.maxOutputTokens");
    expect(advise).toContain("detail text");
    expect(advise).toContain(`${REPAIR_KINDS_VARIABLE}=defaultMaxOutputTokens,fillEmptyToolResult`);

    // 二、候选全开着了：别再劝同一条。
    const exhausted = describeProblemWithRepairAdvice(
      problem("requiredFieldMissing"),
      new Set<IRRepairKind>(["defaultMaxOutputTokens", "fillEmptyToolResult"]));
    expect(exhausted).toContain("already enabled");
    expect(exhausted).not.toContain(`${REPAIR_KINDS_VARIABLE}=`);

    // 三、一条候选都没有：老实说没有，别让人白开一轮。
    // 现在每种 problem kind 都至少有一条修复（`unsatisfiableValue` 由
    // `raiseMaxOutputTokens` 兜住），所以这一支只能靠注入一份空候选表来验 ——
    // 它必须继续可用：下一种 problem kind 登记进来时 `[]` 仍是合法取值。
    const uncovered = describeProblemWithRepairAdvice(
      problem("unsatisfiableValue"), new Set(),
      { ...REPAIRS_FOR_PROBLEM_KIND, unsatisfiableValue: [] });
    expect(uncovered).toContain("no repair kind covers this problem");

    // 而真实那张表上，`unsatisfiableValue` 现在是有解的。
    const raisable = describeProblemWithRepairAdvice(problem("unsatisfiableValue"), new Set());
    expect(raisable).toContain(`${REPAIR_KINDS_VARIABLE}=raiseMaxOutputTokens`);
  });
});
