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
import { EGRESS_PROVIDERS, INGRESS_CODECS, INGRESS_PATHS, INGRESS_PATH_BY_PROTOCOL } from "../src/protocols.ts";
import { IR_PROTOCOLS } from "../src/ir/types.ts";

// 协议清单从唯一授权定义取，不在测试里手抄第二份 —— 手抄的那份改了源不会失败，
// 它只会一起沉默，把「测试覆盖了全部协议」变成一句没人验证的话。
const PROTOCOLS = IR_PROTOCOLS;

describe("入口是封闭集", () => {
  it("恰好三个协议，每个都有 decode 与 encode 两个方向", () => {
    expect(Object.keys(INGRESS_CODECS).sort()).toEqual([...PROTOCOLS].sort());
    for (const protocol of PROTOCOLS) {
      const codec = INGRESS_CODECS[protocol];
      expect(codec.protocol).toBe(protocol);
      expect(typeof codec.readClientRequest).toBe("function");
      expect(typeof codec.writeClientResponse).toBe("function");
    }
  });

  it("每条 HTTP 入口路径都指向一个已登记的协议，且路径数与协议数相等", () => {
    for (const protocol of Object.values(INGRESS_PATHS)) {
      expect(INGRESS_CODECS[protocol]).toBeDefined();
    }
    expect(Object.keys(INGRESS_PATHS)).toHaveLength(PROTOCOLS.length);
  });

  // `INGRESS_PATHS` 是 `INGRESS_PATH_BY_PROTOCOL` 机械反转出来的，「每个协议都有路径」
  // 已由 `satisfies Record<IRProtocol, string>` 在编译期兜住。类型系统兜不住的只剩一件事：
  // **两个协议填了同一个路径字符串** —— 值相等不可判，反转时后者覆盖前者，被覆盖的那个协议
  // 静默不可达（客户端打过来 404，而三张表看起来都是对的）。这条测试就是那个兜底。
  it("协议 → 路径 → 协议 往返回到自身：没有两个协议共用一个路径", () => {
    for (const protocol of PROTOCOLS) {
      const path = INGRESS_PATH_BY_PROTOCOL[protocol];
      expect(INGRESS_PATHS[path]).toBe(protocol);
    }
    expect(new Set(Object.values(INGRESS_PATH_BY_PROTOCOL)).size).toBe(PROTOCOLS.length);
  });
});

describe("出口是开放集", () => {
  it("出口键空间与客户端协议**独立** —— 不是不相交，是互不约束", () => {
    // 早先这条断言写成了「没有任何出口能与客户端协议同名」，那是过强且错的：
    // Anthropic Messages 与 OpenAI Responses 本来就既是客户端协议又是上游 API。
    // 两条轴要锁的是**独立**：出口键空间开放，不必是、也不必不是客户端协议。
    const providerNames = Object.keys(EGRESS_PROVIDERS);

    // 存在既是客户端协议、又是上游 API 的出口（重叠是允许的）
    expect(providerNames.some((name) => (PROTOCOLS as readonly string[]).includes(name))).toBe(true);
    // 也存在**根本不是**任何客户端协议的出口 —— 这才是两条轴必须分开的实证
    expect(providerNames.some((name) => !(PROTOCOLS as readonly string[]).includes(name))).toBe(true);

    expect(EGRESS_PROVIDERS.anthropic.wire).toBe("anthropic_messages_sse");
  });
});

describe("路由数只随出口线性增长", () => {
  it("路由数 = 入口数 × 出口数，且每个组合恰好出现一次", () => {
    const routes = availableRoutes(INGRESS_CODECS, EGRESS_PROVIDERS);
    const ingressCount = Object.keys(INGRESS_CODECS).length;
    const egressCount = Object.keys(EGRESS_PROVIDERS).length;
    expect(routes).toHaveLength(ingressCount * egressCount);
    // 去重后仍是全量，说明没有重复也没有遗漏的组合
    expect(new Set(routes.map((route) => `${route.from}->${route.to}`)).size).toBe(routes.length);
    for (const from of PROTOCOLS) {
      for (const to of Object.keys(EGRESS_PROVIDERS)) {
        expect(routes.some((route) => route.from === from && route.to === to)).toBe(true);
      }
    }
  });

  it("Gemini CloudCode 已在册 —— 它只能当出口，是两条轴分开的实证", () => {
    expect(Object.keys(EGRESS_PROVIDERS)).toContain("gemini_cloudcode");
    expect(EGRESS_PROVIDERS.gemini_cloudcode.wire).toBe("google_cloudcode_stream_generate_content_sse");
    // 出口名不是任何客户端协议
    expect(PROTOCOLS).not.toContain("gemini_cloudcode" as never);
  });

  it("接一家新上游的边际收益恒为 3 —— 两个函数换三条路由", () => {
    expect(routesPerNewEgress(INGRESS_CODECS)).toBe(PROTOCOLS.length);

    const stub = { name: "x", wire: "x", create: (() => { throw new Error("not called"); }) as never };
    const baseline = availableRoutes(INGRESS_CODECS, EGRESS_PROVIDERS).length;
    const withOneMore: IREgressRegistry = { ...EGRESS_PROVIDERS, windsurf_connect: { ...stub, name: "windsurf_connect" } };
    const withTwoMore: IREgressRegistry = { ...withOneMore, bedrock: { ...stub, name: "bedrock" } };

    // 每接一家，路由数恰好 +3（= 入口数），不是 +1
    expect(availableRoutes(INGRESS_CODECS, withOneMore)).toHaveLength(baseline + PROTOCOLS.length);
    expect(availableRoutes(INGRESS_CODECS, withTwoMore)).toHaveLength(baseline + 2 * PROTOCOLS.length);

    // 关键：入口侧一行没改，却多出六条路由。
    expect(Object.keys(INGRESS_CODECS)).toHaveLength(PROTOCOLS.length);
  });
});
