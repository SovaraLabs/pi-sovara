import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativePi } from "./nativePi.ts";
import { completion } from "./helpers.ts";

for (const fail of [false, true])
  test(`Pi native MCP ${fail ? "error" : "success"} executes and records once`, async () => {
    const h = await nativePi({}, async (cwd) => {
      await writeFile(
        join(cwd, ".pi/mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [
                resolve("test/fixtures/mcp.mjs"),
                join(cwd, "mcp-calls.jsonl"),
              ],
              exposure: "direct",
            },
          },
        }),
      );
    });
    try {
      let requests = 0;
      h.server.provider((_body, response) => {
        completion(
          response,
          "ACK",
          requests++ === 0
            ? { name: "mcp__fixture__lookup", arguments: { fail } }
            : undefined,
        );
      });
      await h.session.prompt("Use the controlled MCP lookup");
      assert(
        h.server.calls
          .find((c) => c.path === "/v1/chat/completions")!
          .body.tools.some(
            (tool: any) => tool.function?.name === "mcp__fixture__lookup",
          ),
      );
      const executions = (
        await readFile(join(h.cwd, "mcp-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      assert.equal(executions.length, 1);
      const prepares = h.server.calls.filter((c) =>
        c.path.endsWith("/prepare"),
      );
      const tools = prepares.filter((c) => c.body.api_type === "sovara.trace");
      assert.equal(tools.length, 1);
      assert.equal(tools[0].body.step_kind, "mcp");
      const finals = h.server.calls.filter(
        (c) => c.path.endsWith("/finalize") && c.body.step_kind === "mcp",
      );
      assert.equal(finals.length, 1);
      assert.equal(
        finals[0].body.status ?? "success",
        fail ? "error" : "success",
      );
      assert.match(
        finals[0].body.output_json,
        fail ? /Controlled MCP error result/ : /Controlled MCP success/,
      );
      assert.equal(requests, 2);
      assert.equal(
        prepares.filter((c) => c.body.api_type === "httpx.Client.send").length,
        2,
      );
      assert.doesNotMatch(
        JSON.stringify(h.session.messages),
        /TEMPORARY_LESSON_/,
      );
    } finally {
      await h.close();
    }
  });
