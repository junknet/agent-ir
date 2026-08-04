/**
 * 两条**不同的轴**：入口协议与出口供应商。
 *
 * 早先的版本把 `createEgress` 挂在协议 codec 上，等于假设「出口 ⊆ 入口协议」——这是错的。
 * Windsurf 的 Connect/protobuf、Gemini 的 `v1internal:streamGenerateContent` 根本不是任何
 * 客户端协议，它们**只能当出口**；Anthropic Messages 恰好两边都是，那是巧合（它既是客户端
 * 协议又是上游 API），不是结构规律。
 *
 *   inbox   封闭集，锁定三个        decode + encode        写完永不再长
 *   outbox  开放集，3 + n           lower  + lift          每加一家只付两个函数
 *
 * 于是路由数是 `3 × (3+n)`，不是 `N²`；而**新增一个上游的边际成本恒定是两个函数**，
 * 它换来的是「全部三个入口都能路由到它」。这是这套 IR 的全部经济意义：
 * 客户端协议的组合爆炸被入口侧一次性吸收，上游侧只按线性付费。
 */
import type { IRDecodeResult, IREgress, IREvent, IRProtocol, IRRequest } from "./types.ts";
import type { EncodeOptions } from "../ingress/shared.ts";

// ── 入口：封闭集 ────────────────────────────────────────────────────────────

export type IRRequestDecoder = (raw: unknown, traceId: string) => IRDecodeResult;

export type IRResponseEncoder = (
  events: AsyncIterable<IREvent>,
  request: IRRequest,
  options: EncodeOptions,
) => Response | Promise<Response>;

/**
 * 一个客户端协议的两个方向。世界上的 agent 客户端协议就这三种，因此这是封闭集：
 * 补齐一次之后，新增上游再也不需要碰它。
 */
export interface IRIngressCodec {
  readonly protocol: IRProtocol;
  readonly decodeRequest: IRRequestDecoder;
  readonly encodeResponse: IRResponseEncoder;
}

/** 键必须覆盖全部三个协议，缺一个编译期报错。 */
export type IRIngressRegistry = Readonly<Record<IRProtocol, IRIngressCodec>>;

// ── 出口：开放集 ────────────────────────────────────────────────────────────

/**
 * 一个上游供应商的两个方向 + 一份静态能力声明。
 *
 * 用 `name` 而不是 `IRProtocol` 作键：出口不必是客户端协议。加 Gemini CloudCode、
 * Windsurf Connect、Bedrock 都只是往这张表里加一行，入口侧零改动。
 */
export interface IREgressDescriptor<TOptions = unknown> {
  readonly name: string;
  /** 上游的 wire 家族，仅用于诊断与文档，不参与裁决。 */
  readonly wire: string;
  readonly create: (options: TOptions) => IREgress;
}

export type IREgressRegistry = Readonly<Record<string, IREgressDescriptor<never>>>;

// ── 路由 ────────────────────────────────────────────────────────────────────

export interface IRRoute {
  readonly from: IRProtocol;
  readonly to: string;
}

/**
 * 入口 × 出口的全部组合。长度 = `入口数 × 出口数`。
 *
 * 入口数恒为 3，所以这个函数的返回长度**只随出口数线性增长** —— 每接一家新上游
 * 一次性多出 3 条路由，而不是一条。
 */
export function availableRoutes(
  ingress: IRIngressRegistry,
  egress: IREgressRegistry,
): IRRoute[] {
  const routes: IRRoute[] = [];
  for (const protocol of Object.keys(ingress) as IRProtocol[]) {
    for (const provider of Object.keys(egress)) {
      routes.push({ from: protocol, to: provider });
    }
  }
  return routes;
}

/** 接一家新上游的边际收益：恒等于入口数。用于把这套架构的经济性写成可断言的数字。 */
export function routesPerNewEgress(ingress: IRIngressRegistry): number {
  return Object.keys(ingress).length;
}
