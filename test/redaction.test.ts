import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redaction.ts";
import { Recorder, createClient } from "../src/recorder.ts";
import { fixtureServer } from "./helpers.ts";
test("known credential fields and delegated tokens stay out of explicit tool payloads", async () => {
  assert.deepEqual(
    redact(
      { traceWriteToken: "controlled", input_tokens: 5, tokenizer: "keep" },
      [],
    ),
    { traceWriteToken: "[REDACTED]", input_tokens: 5, tokenizer: "keep" },
  );
  const server = await fixtureServer();
  try {
    const recorder = new Recorder(
      createClient(server.config),
      server.config,
      "session",
    );
    await recorder.start("task");
    const token = recorder.turn!.exportParentContext().traceWriteToken;
    await recorder.beginTool("id", "shell", { command: `echo ${token}` });
    await recorder.endTool("id", { text: token }, true);
    await recorder.close();
    const captures = server.calls.filter(
      (c) => c.path.endsWith("/prepare") || c.path.endsWith("/finalize"),
    );
    assert(!JSON.stringify(captures.map((c) => c.body)).includes(token));
    assert(captures.every((c) => c.headers["x-sovara-trace-token"] === token));
  } finally {
    await server.close();
  }
});
