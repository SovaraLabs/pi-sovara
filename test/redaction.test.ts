import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redaction.ts";
import { SovaraClient } from "../src/client.ts";
import { fixtureServer } from "./helpers.ts";

test("credential fields and known secrets are masked without removing token counts", () => {
  assert.deepEqual(
    redact(
      {
        apiKey: "provider-secret",
        usage: { input_tokens: 20 },
        text: "key=known-secret",
      },
      ["known-secret"],
    ),
    {
      apiKey: "[REDACTED]",
      usage: { input_tokens: 20 },
      text: "key=[REDACTED]",
    },
  );
});

test("captured bodies redact inherited and recording credentials; auth remains usable", async () => {
  const backend = await fixtureServer();
  try {
    const client = new SovaraClient(backend.config);
    client.protect("parent-secret");
    await client.connect();
    const recording = await client.register("session", "/repo");
    const scope = await client.turn(recording, "task");
    const step = await client.prepare(scope, "sovara.trace", "tool", {
      api_key: "provider-secret",
      content: "parent-secret recording-secret agent-secret",
    });
    await client.finish(step, "parent-secret recording-secret");
    for (const call of backend.calls.filter((c) =>
      /prepare|finalize/.test(c.path),
    )) {
      assert.doesNotMatch(
        JSON.stringify(call.body),
        /parent-secret|recording-secret|agent-secret|provider-secret/,
      );
      assert.equal(call.headers["x-sovara-run-token"], "recording-secret");
    }
  } finally {
    await backend.close();
  }
});
