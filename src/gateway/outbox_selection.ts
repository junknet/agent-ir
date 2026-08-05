/**
 * 「按配置选一个出口」的全部实现。
 *
 * 这里要同时满足两件互相拉扯的事：
 *
 *   **每家的 options 形状不同**（`AnthropicOutboxOptions` / `WindsurfOutboxOptions` …），
 *   **但选择发生在运行时**（`AGENT_IR_OUTBOX` 是个字符串）。
 *
 * 用 `any` 抹平是最省事的答案，代价是「anthropic 的 options 传给 windsurf 的 create」
 * 这种接错线永远不会被编译器发现。这里的做法是把泛型**留在登记点、只在边界擦除一次**：
 *
 *   - `OutboxOptionsOf<N>` / `OutboxBodyOf<N>` 从 `OUTBOX_REGISTRY` **反推**，
 *     不是第二份手写清单：注册表里那家的 options 形状变了，这里跟着变。
 *   - `defineOutboxSelection` 在每个登记点上把 `readOptions` 的返回值与 `create` 的入参
 *     绑成同一个 `OutboxOptionsOf<N>`。接错线（把 windsurf 的 create 填进 anthropic 那一行）
 *     是编译错误，因为两个 options 形状不互相赋值。
 *   - 返回值 `BoundOutboxSelection` 里泛型已擦除成 `IROutbox<IRWireBody>`。这是**加宽**
 *     （`TBody extends IRWireBody`，返回位置协变）而不是断言，编译器仍然核对。
 *     传输层因此拿到 `string | Uint8Array` 直接交给 fetch，不需要任何协议特判。
 *
 * 模型不在配置里：出站模型 id 按请求由 `model_routing` 定，所以 `readOptions` 是**柯里化**的
 * —— 外层读完环境（缺变量在启动期就抛），内层只把模型 id 拼进去。这样「校验环境」不需要
 * 先编一个假模型，也不需要另立一份「本出口读哪些变量」的清单去和实现对账。
 */
import { OUTBOX_REGISTRY } from "../protocols.ts";
import {
  createCloudCodeProjectSource, createGeminiOAuthTokenSource,
} from "../outbox/gemini_cloudcode.ts";
import type { IROutbox, IRWireBody } from "../ir/types.ts";
import { readOptionalText, readRequiredText, type EnvLookup } from "./env.ts";

/** 出口名。键从 `OUTBOX_REGISTRY` 来，注册表加一家这里自动多一个合法值。 */
export type OutboxName = keyof typeof OUTBOX_REGISTRY;

/** 选中出口 N 时，它的 options 形状。**按 N 取对应形状**的类型层表达。 */
export type OutboxOptionsOf<N extends OutboxName> =
  Parameters<(typeof OUTBOX_REGISTRY)[N]["create"]>[0];

/** 选中出口 N 时，它的 wire body 形状（windsurf 是 `Uint8Array`，其余是 `string`）。 */
export type OutboxBodyOf<N extends OutboxName> =
  ReturnType<(typeof OUTBOX_REGISTRY)[N]["create"]> extends IROutbox<infer TBody> ? TBody : never;

/** 上游模型 id → 可用出口实例。同一个 id 只造一次（见 `defineOutboxSelection`）。 */
export type OutboxFactory = (outboxModel: string) => IROutbox<IRWireBody>;

/** 一个出口的配置读法，**泛型已擦除**：这是 server 层唯一看得到的形状。 */
export interface BoundOutboxSelection {
  readonly name: OutboxName;
  /** 上游 wire 家族，只进启动日志，不参与裁决。 */
  readonly wire: string;
  /**
   * 读环境并校验，得到出口工厂。**缺变量在这一步抛**（启动期），不是第一条请求进来才抛。
   */
  readonly bind: (env: EnvLookup) => OutboxFactory;
}

/**
 * 本出口的环境变量前缀，由注册表键机械派生：`AGENT_IR_<KEY 大写>_<FIELD>`。
 *
 * 派生而不是每家手写一个前缀常量：手写的那份和键漂移了没有任何东西会报错，
 * 症状是运维照文档设了变量而进程读的是另一个名字。
 */
function envKeyFactory(name: OutboxName): (field: string) => string {
  const prefix = `AGENT_IR_${name.toUpperCase()}`;
  return (field) => `${prefix}_${field}`;
}

interface OutboxSelectionSpec<N extends OutboxName, TBody extends IRWireBody> {
  /**
   * 外层：读环境（缺就抛）。内层：把出站模型 id 拼成这一家的完整 options。
   * 返回类型钉死在 `OutboxOptionsOf<N>`，少一个必填字段就是编译错误。
   */
  readonly readOptions: (
    env: EnvLookup, key: (field: string) => string,
  ) => (outboxModel: string) => OutboxOptionsOf<N>;
  /**
   * 注册表里同名那一家的 `create`。入参钉死在 `OutboxOptionsOf<N>`，
   * 所以填错一家（形状不匹配）当场编译失败。
   */
  readonly create: (options: OutboxOptionsOf<N>) => IROutbox<TBody>;
}

function defineOutboxSelection<N extends OutboxName, TBody extends IRWireBody>(
  name: N,
  spec: OutboxSelectionSpec<N, TBody>,
): BoundOutboxSelection {
  const key = envKeyFactory(name);
  return {
    name,
    wire: OUTBOX_REGISTRY[name].wire,
    bind: (env) => {
      const withModel = spec.readOptions(env, key);
      // 出口实例可能持有凭据缓存、protobuf schema、连接状态：一个上游模型 id 只造一次。
      // 缓存的键是**出站模型 id**而不是客户端模型名 —— 两个客户端名映射到同一个上游 id 时
      // 它们本来就该共用同一个实例。
      const instances = new Map<string, IROutbox<IRWireBody>>();
      return (outboxModel) => {
        const cached = instances.get(outboxModel);
        if (cached !== undefined) return cached;
        const created = spec.create(withModel(outboxModel));
        instances.set(outboxModel, created);
        return created;
      };
    },
  };
}

/**
 * 出口名 → 配置读法。**键由 `OutboxName` 穷举**：`OUTBOX_REGISTRY` 里加一家而这里漏登记，
 * 这一行赋值当场编译失败，而不是上线后发现那个出口名「合法但起不来」。
 */
export const OUTBOX_SELECTIONS: Readonly<Record<OutboxName, BoundOutboxSelection>> = {
  anthropic: defineOutboxSelection("anthropic", {
    create: OUTBOX_REGISTRY.anthropic.create,
    readOptions: (env, key) => {
      const baseUrl = readRequiredText(env, key("BASE_URL"));
      const apiKey = readRequiredText(env, key("API_KEY"));
      const anthropicVersion = readOptionalText(env, key("VERSION"));
      return (model) => ({
        baseUrl, apiKey, model,
        ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
      });
    },
  }),

  /** Copilot 与 anthropic 同一份投影，但 base URL 是每个凭据自己的，且 session token 会过期。 */
  copilot: defineOutboxSelection("copilot", {
    create: OUTBOX_REGISTRY.copilot.create,
    readOptions: (env, key) => {
      const apiBase = readRequiredText(env, key("API_BASE"));
      const sessionToken = readRequiredText(env, key("SESSION_TOKEN"));
      const githubToken = readRequiredText(env, key("GITHUB_TOKEN"));
      return (model) => ({
        apiBase, sessionToken, githubToken, model,
      });
    },
  }),

  openai_chat: defineOutboxSelection("openai_chat", {
    create: OUTBOX_REGISTRY.openai_chat.create,
    readOptions: (env, key) => {
      const baseUrl = readRequiredText(env, key("BASE_URL"));
      const apiKey = readRequiredText(env, key("API_KEY"));
      return (model) => ({ baseUrl, apiKey, model });
    },
  }),

  openai_responses: defineOutboxSelection("openai_responses", {
    create: OUTBOX_REGISTRY.openai_responses.create,
    readOptions: (env, key) => {
      const baseUrl = readRequiredText(env, key("BASE_URL"));
      const apiKey = readRequiredText(env, key("API_KEY"));
      return (model) => ({ baseUrl, apiKey, model });
    },
  }),

  gemini_cloudcode: defineOutboxSelection("gemini_cloudcode", {
    create: OUTBOX_REGISTRY.gemini_cloudcode.create,
    readOptions: (env, key) => {
      // 凭据有两种来源，二选一是显式的：给了字面 token 就用它，否则走 OAuth 文件。
      // 「没配就静默用默认路径」在这里是可接受的，因为默认路径是这家上游的既定约定
      // （`~/.gemini/oauth_creds.json`），文件不存在时第一次取 token 会带路径报错。
      const literalToken = readOptionalText(env, key("ACCESS_TOKEN"));
      const credentialsPath = readOptionalText(env, key("CREDENTIALS_PATH"));
      const accessToken = literalToken ?? createGeminiOAuthTokenSource(
        credentialsPath === undefined ? {} : { path: credentialsPath },
      );
      const host = readOptionalText(env, key("HOST"));
      const literalProject = readOptionalText(env, key("PROJECT"));
      const project = literalProject ?? createCloudCodeProjectSource({
        accessToken, ...(host === undefined ? {} : { host }),
      });
      return (model) => ({
        model, accessToken, project,
        ...(host === undefined ? {} : { host }),
      });
    },
  }),

  windsurf: defineOutboxSelection("windsurf", {
    create: OUTBOX_REGISTRY.windsurf.create,
    readOptions: (env, key) => {
      const apiKey = readRequiredText(env, key("API_KEY"));
      const server = readOptionalText(env, key("SERVER"));
      const fdsPath = readOptionalText(env, key("FDS_PATH"));
      return (model) => ({
        model, apiKey,
        ...(server === undefined ? {} : { server }),
        ...(fdsPath === undefined ? {} : { fdsPath }),
      });
    },
  }),
};

/**
 * 全部合法出口名。**取自注册表本身**，不是手抄的第二份清单 ——
 * 启动失败时列给运维看的就是它，所以它必须与真正能选的集合是同一个东西。
 */
export const OUTBOX_NAMES: readonly OutboxName[] = Object.keys(OUTBOX_REGISTRY) as OutboxName[];
