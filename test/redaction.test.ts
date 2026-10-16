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

test("structured run I/O and step payloads redact before JSON encoding", async () => {
  const backend = await fixtureServer();
  try {
    const secret = 'quoted"secret\nwith-newline';
    const client = new SovaraClient(backend.config);
    client.protect(secret);
    await client.connect();
    const recording = await client.register("session", "/repo");
    const content = [
      {
        type: "toolCall",
        arguments: { api_key: "service-secret" },
        text: secret,
      },
    ];
    const scope = await client.turn(recording, content);
    await client.io(scope, "input", content);
    await client.io(scope, "output", content);
    const step = await client.prepare(scope, "sovara.trace", "tool", content);
    await client.finish(step, content);
    for (const call of backend.calls.filter((call) =>
      /turns|run-io|prepare|finalize/.test(call.path),
    )) {
      for (const key of ["turn_input", "value", "input_json", "output_json"]) {
        if (!(key in call.body)) continue;
        const decoded = JSON.parse(call.body[key]);
        const parts = Array.isArray(decoded)
          ? decoded
          : key === "output_json"
            ? decoded.raw.tool_output
            : decoded.raw;
        assert.equal(parts[0].arguments.api_key, "[REDACTED]");
        assert.equal(parts[0].text, "[REDACTED]");
      }
    }
  } finally {
    await backend.close();
  }
});
