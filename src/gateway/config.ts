/**
 * 网关配置的**唯一装配点**：一份环境 → 一个完整可用的 `GatewayConfig`。
 *
 * 「构造成功即可用」（Construct valid or fail）：这个函数返回之后不存在任何
 * 「还没校验」的字段 —— 出口已绑好、模型表已解析、修复策略已核对、流策略已成型。
 * 所有会失败的判断都发生在这里，而不是散在第一条请求的处理路径上。
 *
 * server.ts 因此变成一个纯组合根：读配置 → 装配 → 起 HTTP。
 */
import {
  DEFAULT_STREAM_POLICY, type IRStreamPolicy,
} from "../ir/stream_guard.ts";
import {
  jsonSink, parseLogLevel, textSink, type LoggerConfig,
} from "../obs/log.ts";
import {
  IR_REPAIR_KINDS, type IRRepairKind, type IRRepairPolicy,
} from "../repair/index.ts";
import {
  EGRESS_CONFIGS, EGRESS_NAMES, type EgressFactory, type EgressName,
} from "./egress_selection.ts";
import {
  readEnumeratedList, readEnumeratedText, readOptionalDurationMs, readOptionalText,
  readPositiveInteger, type EnvLookup,
} from "./env.ts";
import { readModelRoutingTable, type ModelRoutingTable } from "./model_routing.ts";
import { REPAIR_KINDS_VARIABLE } from "./repair_advice.ts";

export const EGRESS_VARIABLE = "AGENT_IR_EGRESS";

export interface SelectedEgress {
  readonly name: EgressName;
  readonly wire: string;
  /** 上游模型 id → 出口实例。已按模型 id 记忆化。 */
  readonly resolve: EgressFactory;
}

export interface GatewayConfig {
  readonly port: number;
  readonly logging: LoggerConfig;
  readonly egress: SelectedEgress;
  readonly models: ModelRoutingTable;
  /**
   * 修复策略。`IR_REPAIR_POLICY_NONE` 的等价物（空对象）= 一条都不修，这是**默认值**：
   * 确定性是默认，修复是显式选择。
   */
  readonly repairPolicy: IRRepairPolicy;
  /** 启用了哪几条 —— 供日志与拒绝信息使用（`repairPolicy` 的键序不可依赖）。 */
  readonly repairKinds: readonly IRRepairKind[];
  readonly streamPolicy: IRStreamPolicy;
}

/**
 * 修复种类名单 → 策略对象。
 *
 * **不是布尔**：布尔说不清「到底替我决定了什么」。这里每一条都是一个具名的种类，
 * 打开哪几条就写哪几条，拼错一条整体启动失败（`readEnumeratedList`）。
 * 每条的旋钮留空（`{}`）= 用 `IR_REPAIR_SPECS[kind].defaults` 里那份唯一默认值。
 */
function readRepairPolicy(env: EnvLookup): { policy: IRRepairPolicy; kinds: readonly IRRepairKind[] } {
  const kinds = readEnumeratedList(env, REPAIR_KINDS_VARIABLE, IR_REPAIR_KINDS);
  // 键存在 = 启用。`{}` 让规格表里的 defaults 生效，不在这里复制第二份默认值。
  const policy: IRRepairPolicy = Object.fromEntries(kinds.map((kind) => [kind, {}]));
  return { policy, kinds };
}

/**
 * 流守卫策略。**默认值原样取自 `DEFAULT_STREAM_POLICY`**（生产标定值），
 * 这里只提供逐字段覆盖，不重新标定 —— 复制一份数字就等于多一个会漂移的真值来源。
 */
function readStreamPolicy(env: EnvLookup): IRStreamPolicy {
  return {
    precommitTotalMs: readPositiveInteger(
      env, "AGENT_IR_STREAM_PRECOMMIT_TOTAL_MS", DEFAULT_STREAM_POLICY.precommitTotalMs),
    precommitIdleMs: readPositiveInteger(
      env, "AGENT_IR_STREAM_PRECOMMIT_IDLE_MS", DEFAULT_STREAM_POLICY.precommitIdleMs),
    postcommitIdleMs: readOptionalDurationMs(
      env, "AGENT_IR_STREAM_POSTCOMMIT_IDLE_MS", DEFAULT_STREAM_POLICY.postcommitIdleMs),
    heartbeatMs: readPositiveInteger(
      env, "AGENT_IR_STREAM_HEARTBEAT_MS", DEFAULT_STREAM_POLICY.heartbeatMs),
  };
}

function readLoggingConfig(env: EnvLookup): LoggerConfig {
  const dev = (readOptionalText(env, "AGENT_IR_ENV") ?? "dev") === "dev";
  const format = readEnumeratedText(
    env, "AGENT_IR_LOG_FORMAT", ["text", "json"] as const, dev ? "text" : "json");
  return {
    level: parseLogLevel(readOptionalText(env, "AGENT_IR_LOG_LEVEL"), dev ? "debug" : "info"),
    service: readOptionalText(env, "AGENT_IR_SERVICE") ?? "agent-ir",
    sink: format === "text" ? textSink() : jsonSink(),
  };
}

/**
 * 读一份完整配置。任何一处不合法都抛 `GatewayConfigError`，进程别起来。
 *
 * 出口名没有默认值：**必须显式选**。给一个默认出口意味着「什么都不配也能起」，
 * 而那正是这次改造要消灭的形态 —— 进程起来了，路由却不是运维以为的那条。
 */
export function readGatewayConfig(env: EnvLookup): GatewayConfig {
  const name = readEnumeratedText(env, EGRESS_VARIABLE, EGRESS_NAMES, null);
  const selected = EGRESS_CONFIGS[name];
  const { policy, kinds } = readRepairPolicy(env);
  return {
    port: readPositiveInteger(env, "AGENT_IR_PORT", 9797),
    logging: readLoggingConfig(env),
    egress: { name: selected.name, wire: selected.wire, resolve: selected.bind(env) },
    models: readModelRoutingTable(env),
    repairPolicy: policy,
    repairKinds: kinds,
    streamPolicy: readStreamPolicy(env),
  };
}
