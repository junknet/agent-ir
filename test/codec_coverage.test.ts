/**
 * 两条轴的形状与路由数。
 *
 * 这组测试不测行为，测的是**架构的经济性**：入口是封闭集（三个，写完不再长），
 * 出口是开放集（每加一家付两个函数），因此路由数 = 3 × 出口数，只随出口线性增长。
 *
 * 它同时是一张会自己更新的账：接一家新上游后路由数会跳 +3，这里的断言就会失败，
 * 逼你把新增能力写进来，而不是悄悄多出几条没人知道的路。
 */
import { describe, expect, it } from "bun:test";
import { availableRoutes, routesPerNewEgress, type IREgressRegistry } from "../src/ir/codec.ts";
import { EGRESS_PROVIDERS, INGRESS_CODECS, INGRESS_PATHS } from "../src/protocols.ts";
import type { IRProtocol } from "../src/ir/types.ts";

const PROTOCOLS: readonly IRProtocol[] = [
  "anthropic_messages", "openai_responses", "openai_chat_completions",
];

describe("入口是封闭集", () => {
  it("恰好三个协议，每个都有 decode 与 encode 两个方向", () => {
    expect(Object.keys(INGRESS_CODECS).sort()).toEqual([...PROTOCOLS].sort());
    for (const protocol of PROTOCOLS) {
      const codec = INGRESS_CODECS[protocol];
      expect(codec.protocol).toBe(protocol);
      expect(typeof codec.decodeRequest).toBe("function");
      expect(typeof codec.encodeResponse).toBe("function");
    }
  });

  it("每条 HTTP 入口路径都指向一个已登记的协议，且路径数与协议数相等", () => {
    for (const protocol of Object.values(INGRESS_PATHS)) {
      expect(INGRESS_CODECS[protocol]).toBeDefined();
    }
    expect(Object.keys(INGRESS_PATHS)).toHaveLength(PROTOCOLS.length);
  });
});

describe("出口是开放集", () => {
  it("出口以供应商名为键，不以客户端协议为键 —— 出口不必是任何客户端协议", () => {
    // Windsurf 的 Connect/protobuf、Gemini 的 streamGenerateContent 都只能当出口。
    // 这条断言锁的就是「两条轴分开」这个结构决定。
    const providerNames = Object.keys(EGRESS_PROVIDERS);
    for (const name of providerNames) {
      expect(PROTOCOLS).not.toContain(name as IRProtocol);
    }
    expect(EGRESS_PROVIDERS.anthropic.wire).toBe("anthropic_messages_sse");
  });
});

describe("路由数只随出口线性增长", () => {
  it("当前 3 入口 × 1 出口 = 3 条", () => {
    const routes = availableRoutes(INGRESS_CODECS, EGRESS_PROVIDERS);
    expect(routes).toHaveLength(3);
    expect(routes.map((route) => route.from).sort()).toEqual([...PROTOCOLS].sort());
    expect(routes.every((route) => route.to === "anthropic")).toBe(true);
  });

  it("接一家新上游的边际收益恒为 3 —— 两个函数换三条路由", () => {
    expect(routesPerNewEgress(INGRESS_CODECS)).toBe(PROTOCOLS.length);

    const stub = { name: "x", wire: "x", create: (() => { throw new Error("not called"); }) as never };
    const withGemini: IREgressRegistry = { ...EGRESS_PROVIDERS, gemini_cloudcode: { ...stub, name: "gemini_cloudcode" } };
    const withWindsurf: IREgressRegistry = { ...withGemini, windsurf_connect: { ...stub, name: "windsurf_connect" } };

    expect(availableRoutes(INGRESS_CODECS, withGemini)).toHaveLength(6);
    expect(availableRoutes(INGRESS_CODECS, withWindsurf)).toHaveLength(9);

    // 关键：入口侧一行没改，却多出六条路由。
    expect(Object.keys(INGRESS_CODECS)).toHaveLength(PROTOCOLS.length);
  });
});
