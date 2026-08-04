/**
 * 客户端模型名 → 上游模型 id。
 *
 * 这是两个**不同命名空间**的翻译，不是一个字段的透传：IR 里的 `model` 是客户端说的
 * （`claude-opus-5`、`gpt-5.1-codex`），出口要的是那家上游自己签发的 id
 * （windsurf 的 `chat_model_uid`、gemini 的档位模型名）。把客户端那串直接塞给上游，
 * 在名字碰巧一致的那家上能跑，在其余四家上换回一个语义模糊的 4xx。
 *
 * 所以它是**策略数据**：一张具名的 typed 表 + 一个具名的兜底档，在一处登记，
 * 由一个通用查表函数消费；没有 if 链，也没有「以 claude- 开头就……」这类猜测规则
 * —— 前缀规则读起来像省事，实际是把一张表压进代码，改一次要读一遍分支。
 *
 * 不中时的默认行为是**拒绝**（`refuse`），理由：
 *   1. 这张表的全部价值是「路由可读」。默认透传等于「配不配都能跑」，那就没人会配它，
 *      而配错的人拿到的是上游的 opaque 4xx，指不回网关这边的配置。
 *   2. 与 Core 同一条判据：表达不了就带精确位置拒绝，绝不发一个必然失败的请求上去。
 * 想要透传的调用方显式写 `AGENT_IR_MODEL_FALLBACK=passthrough` —— 那是一个决定，
 * 决定就该写下来。
 */
import {
  GatewayConfigError, readOptionalText, readTextList, type EnvLookup,
} from "./env.ts";

/** 表里没有这个客户端模型时怎么办。三种，都是显式写出来的选择。 */
export type ModelFallback =
  /** 拒绝（默认）。响应会把已登记的客户端模型名列全。 */
  | { readonly kind: "refuse" }
  /** 把客户端那串原样当上游 id 发出去。名字空间恰好一致的部署可以这么配。 */
  | { readonly kind: "passthrough" }
  /** 统一落到一个上游 id 上。单模型部署常用。 */
  | { readonly kind: "pinned"; readonly upstreamModel: string };

export interface ModelRoutingTable {
  /** 客户端模型名 → 上游模型 id。 */
  readonly routes: ReadonlyMap<string, string>;
  readonly fallback: ModelFallback;
}

/**
 * 一次查表的结果。判别联合而不是 `string | null`：
 * 「路由到哪」和「为什么是它」都要进日志，而「没中」是调用方必须表态的正常返回值之一。
 */
export type ModelResolution =
  | { readonly kind: "routed"; readonly upstreamModel: string; readonly via: "table" | "passthrough" | "pinned" }
  | { readonly kind: "unrouted"; readonly clientModel: string; readonly knownClientModels: readonly string[] };

/** 一次查表。**唯一的查法**，没有第二处 `routes.get`。 */
export function resolveUpstreamModel(
  table: ModelRoutingTable, clientModel: string,
): ModelResolution {
  const mapped = table.routes.get(clientModel);
  if (mapped !== undefined) return { kind: "routed", upstreamModel: mapped, via: "table" };
  switch (table.fallback.kind) {
    case "passthrough":
      return { kind: "routed", upstreamModel: clientModel, via: "passthrough" };
    case "pinned":
      return { kind: "routed", upstreamModel: table.fallback.upstreamModel, via: "pinned" };
    case "refuse":
      return {
        kind: "unrouted", clientModel,
        knownClientModels: [...table.routes.keys()],
      };
  }
}

const FALLBACK_VARIABLE = "AGENT_IR_MODEL_FALLBACK";
const MAP_VARIABLE = "AGENT_IR_MODEL_MAP";
const PINNED_PREFIX = "pinned:";

function parseFallback(env: EnvLookup): ModelFallback {
  const raw = readOptionalText(env, FALLBACK_VARIABLE);
  if (raw === undefined || raw === "refuse") return { kind: "refuse" };
  if (raw === "passthrough") return { kind: "passthrough" };
  if (raw.startsWith(PINNED_PREFIX)) {
    const upstreamModel = raw.slice(PINNED_PREFIX.length).trim();
    if (upstreamModel.length === 0) {
      throw new GatewayConfigError(`${FALLBACK_VARIABLE}='${raw}' names no upstream model after '${PINNED_PREFIX}'`);
    }
    return { kind: "pinned", upstreamModel };
  }
  throw new GatewayConfigError(
    `${FALLBACK_VARIABLE}='${raw}' is not recognised; expected one of: refuse, passthrough, ${PINNED_PREFIX}<upstream-model-id>`,
  );
}

/**
 * `AGENT_IR_MODEL_MAP="<客户端名>=<上游 id>,..."` + `AGENT_IR_MODEL_FALLBACK`。
 *
 * 重复的客户端名是**错误**而不是「后写的赢」：两条冲突的登记说明写表的人有两个意图，
 * 静默取一个等于替他挑了一个。
 */
export function readModelRoutingTable(env: EnvLookup): ModelRoutingTable {
  const routes = new Map<string, string>();
  for (const entry of readTextList(env, MAP_VARIABLE)) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new GatewayConfigError(
        `${MAP_VARIABLE} entry '${entry}' is not '<client-model>=<upstream-model>'`,
      );
    }
    const clientModel = entry.slice(0, separator).trim();
    const upstreamModel = entry.slice(separator + 1).trim();
    if (clientModel.length === 0 || upstreamModel.length === 0) {
      throw new GatewayConfigError(
        `${MAP_VARIABLE} entry '${entry}' has an empty side; expected '<client-model>=<upstream-model>'`,
      );
    }
    if (routes.has(clientModel)) {
      throw new GatewayConfigError(
        `${MAP_VARIABLE} maps client model '${clientModel}' twice ('${routes.get(clientModel)}' and '${upstreamModel}')`,
      );
    }
    routes.set(clientModel, upstreamModel);
  }
  return { routes, fallback: parseFallback(env) };
}

/** 给「没路由到」的响应用的一句话，把该配哪个变量说清楚。 */
export function describeUnroutedModel(resolution: Extract<ModelResolution, { kind: "unrouted" }>): string {
  const known = resolution.knownClientModels.length === 0
    ? "the gateway has no model mapping configured"
    : `mapped client models are: ${resolution.knownClientModels.join(", ")}`;
  return `model '${resolution.clientModel}' is not routed by this gateway; ${known}`
    + ` (add '${resolution.clientModel}=<upstream-model-id>' to ${MAP_VARIABLE},`
    + ` or set ${FALLBACK_VARIABLE}=passthrough / ${FALLBACK_VARIABLE}=${PINNED_PREFIX}<upstream-model-id>)`;
}
