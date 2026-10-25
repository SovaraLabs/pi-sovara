import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureServer } from "./helpers.ts";
import { createClient } from "../src/recorder.ts";
test("explicit Pi-selected connection uses the SDK runner contract and no custom auth headers", async () => {
  const server = await fixtureServer();
  try {
    const client = createClient(server.config);
    assert.deepEqual(client.autoInstrumentation, {
      providerHttp: true,
      mcp: false,
    });
    const recording = await client.startRecording("test", {
      captureLogs: false,
    });
    await recording.finish();
    assert.equal(
      server.calls.filter((c) => c.path === "/runner/health").length,
      1,
    );
    assert.equal(
      server.calls.find((c) => c.path === "/runner/register")?.headers[
        "x-sovara-contract-version"
      ],
      "5",
    );
  } finally {
    await server.close();
  }
});
