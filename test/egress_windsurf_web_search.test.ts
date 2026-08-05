import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  createWindsurfWebSearchToolResult,
  createWindsurfWebSearchWireRequest,
  readWindsurfWebSearchDocuments,
} from "../src/egress/windsurf/web_search.ts";
import { getSharedWindsurfSchema } from "../src/egress/windsurf/schema.ts";

describe("Windsurf 专属 web_search RPC", () => {
  it("按真实 application/proto 请求形状编译搜索，并复用 Windsurf 客户端身份", async () => {
    const wire = await createWindsurfWebSearchWireRequest(
      { query: "test query", limit: 8 },
      { apiKey: "devin-session-token$test-token", server: "https://windsurf.invalid" },
    );
    expect(wire.url).toBe("https://windsurf.invalid/exa.api_server_pb.ApiServerService/GetWebSearchResults");
    expect(wire.headers).toMatchObject({
      "content-type": "application/proto",
      authorization: "Basic devin-session-token$test-token",
    });

    const schema = getSharedWindsurfSchema();
    const descriptor = schema.message("exa.api_server_pb.GetWebSearchResultsRequest");
    const decoded = (await import("@bufbuild/protobuf")).fromBinary(descriptor, wire.body) as Record<string, unknown>;
    expect(decoded.query).toBe("test query");
    expect(decoded.limit).toBe(8);
    expect(decoded.metadata).toMatchObject({ apiKey: "devin-session-token$test-token", ideName: "chisel" });
  });

  it("只读取抓包实际使用的搜索字段，并按 tool_call_id 回灌 IR", () => {
    const schema = getSharedWindsurfSchema();
    const responseDescriptor = schema.message("exa.api_server_pb.GetWebSearchResultsResponse");
    const resultDescriptor = schema.childOf(responseDescriptor, "results");
    const response = create(responseDescriptor, {
      results: [create(resultDescriptor, {
        documentId: "document-1", url: "https://example.test/a", title: "A", summary: "summary A",
      })],
    });
    const documents = readWindsurfWebSearchDocuments(toBinary(responseDescriptor, response));
    expect(documents).toEqual([{
      documentId: "document-1", url: "https://example.test/a", title: "A", summary: "summary A",
    }]);
    expect(createWindsurfWebSearchToolResult("web_search_1", documents)).toEqual({
      callId: "web_search_1",
      status: "ok",
      parts: [{ kind: "text", text: JSON.stringify({ results: documents }) }],
    });
  });
});
