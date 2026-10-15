import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLessonBridge } from "../src/mcp.ts";

test("MCP negotiates, exposes only scoped retrieval and refuses unauthenticated callers", async () => {
  const calls: string[] = [];
  const bridge = await startLessonBridge(async (context) => {
    calls.push(context);
    return { lessons: [{ lesson_id: "one" }] };
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    assert.equal((await fetch(bridge.url, { method: "POST" })).status, 403);
    assert.equal(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bridge.token}`,
            Origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name),
      ["retrieve"],
    );
    assert.equal(tools.tools[0].inputSchema.properties?.project, undefined);
    const result = await client.callTool({
      name: "retrieve",
      arguments: { context: "my task", project: "other-project" },
    });
    assert.deepEqual(calls, ["my task"]);
    assert.deepEqual(result.structuredContent, {
      lessons: [{ lesson_id: "one" }],
    });
  } finally {
    await client.close();
    await bridge.close();
  }
});

test("MCP retrieval errors are explicit and sanitized", async () => {
  const bridge = await startLessonBridge(async () => {
    throw new Error("SECRET");
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    const result = await client.callTool({
      name: "retrieve",
      arguments: { context: "task" },
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  } finally {
    await client.close();
    await bridge.close();
  }
});
