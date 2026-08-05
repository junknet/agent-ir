/**
 * 环境读取的**唯一入口**。
 *
 * 两条硬规矩，其余都是它们的推论：
 *
 * 1. **环境是参数，不是环境。** 这一层之外没有任何函数体允许出现 `process.env`；
 *    需要配置的东西通过工厂参数拿到已经校验过的值。于是「这个功能到底读了什么」
 *    可以靠调用链答出来，而不是靠全局搜索。
 * 2. **不合法就启动失败，且把合法取值列全。** 静默回退是这次改造要消灭的形态：
 *    出口名拼错却照常起来，运维会以为路由生效了，直到线上流量全打到默认上游才发现。
 *    所以每个 parse 出错时都要报出「操作 + 期望 + 实际 + 变量名」四件套。
 */

/** `process.env` 的**结构**，不是它本身。测试与 server 都按这个形状传值。 */
export type EnvLookup = Readonly<Record<string, string | undefined>>;

/**
 * 配置错误。与运行时错误分开一个类型，是为了让 server 的启动路径能只捕获它、
 * 打印一条干净的运维可读消息，而不是把栈喷到 stderr 上。
 */
export class GatewaySettingsError extends Error {
  override readonly name = "GatewaySettingsError";
  constructor(message: string) {
    super(message);
  }
}

/** 空串一律视为未设置：`FOO=` 在 shell 里是「我不想设它」，不是「设成空」。 */
function lookup(env: EnvLookup, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function readOptionalText(env: EnvLookup, name: string): string | undefined {
  return lookup(env, name);
}

export function readRequiredText(env: EnvLookup, name: string): string {
  const value = lookup(env, name);
  if (value === undefined) {
    throw new GatewaySettingsError(`${name} is required but unset (or empty)`);
  }
  return value;
}

/**
 * 枚举取值。**这是「拼错就启动失败并列出全部合法值」的唯一实现** ——
 * 出口名、修复种类、模型兜底策略全都从这里过，不各写各的。
 */
export function readEnumeratedText<T extends string>(
  env: EnvLookup,
  name: string,
  allowed: readonly T[],
  fallback: T | null,
): T {
  const raw = lookup(env, name);
  if (raw === undefined) {
    if (fallback !== null) return fallback;
    throw new GatewaySettingsError(
      `${name} is required but unset; expected one of: ${allowed.join(", ")}`,
    );
  }
  const found = allowed.find((candidate) => candidate === raw);
  if (found === undefined) {
    throw new GatewaySettingsError(
      `${name}='${raw}' is not recognised; expected one of: ${allowed.join(", ")}`,
    );
  }
  return found;
}

/** 逗号分隔清单。空/未设 = 空数组，顺带去掉空项与两侧空白。 */
export function readTextList(env: EnvLookup, name: string): readonly string[] {
  const raw = lookup(env, name);
  if (raw === undefined) return [];
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * 逗号分隔的枚举清单。逐项校验：**一项拼错就整体失败**，不是「跳过不认识的」——
 * 跳过等于「你以为开了、其实没开」，正是布尔开关说不清的那种半开状态。
 */
export function readEnumeratedList<T extends string>(
  env: EnvLookup,
  name: string,
  allowed: readonly T[],
): readonly T[] {
  const items = readTextList(env, name);
  const selected: T[] = [];
  for (const item of items) {
    const found = allowed.find((candidate) => candidate === item);
    if (found === undefined) {
      throw new GatewaySettingsError(
        `${name} contains '${item}', which is not a known value; expected a comma-separated subset of: ${allowed.join(", ")}`,
      );
    }
    if (selected.includes(found)) {
      throw new GatewaySettingsError(`${name} lists '${item}' more than once`);
    }
    selected.push(found);
  }
  return selected;
}

export function readPositiveInteger(env: EnvLookup, name: string, fallback: number): number {
  const raw = lookup(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewaySettingsError(`${name}='${raw}' is not a positive integer`);
  }
  return parsed;
}

/**
 * 可关闭的毫秒时长。字面量 `none` = 关掉这条判死线（`null`）。
 *
 * 用具名字面量而不是 `0` 或 `-1` 表达「关掉」：`0ms 静默上限` 与「不因静默掐流」
 * 是两个相反的意思，让它们共用一个数字迟早出现「配了 0 结果全掐了」。
 */
export function readOptionalDurationMs(
  env: EnvLookup, name: string, fallback: number | null,
): number | null {
  const raw = lookup(env, name);
  if (raw === undefined) return fallback;
  if (raw === "none") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewaySettingsError(`${name}='${raw}' is neither 'none' nor a positive integer of milliseconds`);
  }
  return parsed;
}
