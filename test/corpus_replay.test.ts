/**
 * 真实语料回放。
 *
 * 语料是 807 条全量归档的客户端请求原文（.corpus/requests.ndjson，本机生成、不进 Git）。
 * 这个测试回答三个问题，都是「设计对不对」而不是「代码跑不跑」：
 *   1. 三个 decoder 能不能在真实流量上不抛异常
 *   2. opaque 装箱率 —— 高就说明 IR 的类型覆盖不够，是设计缺口不是运行时错误
 *   3. 有损条目都是什么 —— 每一条都必须是**故意**的，不能有意料之外的 loss
 *
 * 语料缺失时跳过而不是失败：CI 上没有生产隧道，但本机开发必须能跑。
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readClientRequestForProtocol } from "../src/inbox/index.ts";
import { IR_LOSS_KINDS } from "../src/ir/types.ts";
import type { IRPart, IRProtocol, IRRequest } from "../src/ir/types.ts";

const CORPUS_PATH = new URL("../.corpus/requests.ndjson", import.meta.url).pathname;

interface CorpusEntry {
  readonly traceId: string;
  readonly protocol: IRProtocol;
  readonly accountType: string;
  readonly body: string;
}

function loadCorpus(): CorpusEntry[] {
  if (!existsSync(CORPUS_PATH)) return [];
  return readFileSync(CORPUS_PATH, "utf-8")
    .split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusEntry);
}

function walkParts(parts: readonly IRPart[], visit: (part: IRPart) => void): void {
  for (const part of parts) {
    visit(part);
    if (part.kind === "toolResult") walkParts(part.result.parts, visit);
  }
}

function allParts(request: IRRequest): IRPart[] {
  const collected: IRPart[] = [];
  walkParts(request.conversation.system, (part) => collected.push(part));
  for (const turn of request.conversation.turns) walkParts(turn.parts, (part) => collected.push(part));
  return collected;
}

const corpus = loadCorpus();

describe("corpus replay", () => {
  it.skipIf(corpus.length === 0)("decodes every archived request without throwing", () => {
    const failures: Array<{ traceId: string; error: string }> = [];
    for (const entry of corpus) {
      try {
        readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      } catch (error) {
        failures.push({ traceId: entry.traceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    expect(failures).toEqual([]);
  });

  it.skipIf(corpus.length === 0)("keeps opaque boxing rare: unmodelled shapes are a design gap", () => {
    let parts = 0;
    let opaque = 0;
    const tags = new Map<string, number>();
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const part of allParts(request)) {
        parts += 1;
        if (part.kind !== "opaque") continue;
        opaque += 1;
        const key = `${part.origin}:${part.tag}`;
        tags.set(key, (tags.get(key) ?? 0) + 1);
      }
    }
    // 装箱的形态必须列得出来；出现新形态时这里会打印，提示补模型而不是默默降级。
    if (tags.size > 0) console.log("opaque tags:", Object.fromEntries(tags));
    expect(parts).toBeGreaterThan(0);
    expect(opaque / parts).toBeLessThan(0.001);
  });

  it.skipIf(corpus.length === 0)("every recorded loss is one of the intended kinds", () => {
    const details = new Map<string, number>();
    for (const entry of corpus) {
      const { losses } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      for (const loss of losses) {
        expect(loss.stage).toBe("inbox");
        expect(IR_LOSS_KINDS).toContain(loss.kind);
        details.set(loss.detail, (details.get(loss.detail) ?? 0) + 1);
      }
    }
    if (details.size > 0) console.log("inbox losses:", Object.fromEntries(details));
  });

  it.skipIf(corpus.length === 0)("preserves tool call/result correlation without positional assumptions", () => {
    let calls = 0;
    let results = 0;
    let orphans = 0;
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      const declared = new Set<string>();
      for (const part of allParts(request)) {
        if (part.kind === "toolCall") { declared.add(part.call.id); calls += 1; }
      }
      for (const part of allParts(request)) {
        if (part.kind !== "toolResult") continue;
        results += 1;
        if (!declared.has(part.result.callId)) orphans += 1;
      }
    }
    console.log(`tool calls=${calls} results=${results} orphans=${orphans}`);
    expect(calls).toBeGreaterThan(0);
    // 真实客户端流量里孤儿结果为 0；出现非 0 说明 decoder 丢了某处的 tool call。
    expect(orphans).toBe(0);
  });

  it.skipIf(corpus.length === 0)("derives capability needs for every request", () => {
    for (const entry of corpus) {
      const { request } = readClientRequestForProtocol(entry.protocol, JSON.parse(entry.body), entry.traceId);
      expect(request.requires.length).toBeGreaterThan(0);
      for (const need of request.requires) expect(need.paths.length).toBeGreaterThan(0);
    }
  });
});
