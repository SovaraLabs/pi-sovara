import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SovaraClient } from "@sovara/sdk";
import { nativePi } from "./nativePi.ts";

// Import the application SDK before Pi loads the extension's own dependency.
const installedFetch = globalThis.fetch;
test("installed Pi and an application SDK share transport ownership while keeping concurrent recording scopes separate", async () => {
  if (process.env.SOVARA_TEST_PACKAGE_ROOT) {
    const extensionSdk = await realpath(
      resolve(process.env.SOVARA_TEST_PACKAGE_ROOT, "../sdk/dist/index.js"),
    );
    assert.notEqual(
      extensionSdk,
      await realpath(fileURLToPath(import.meta.resolve("@sovara/sdk"))),
      "Installed test must exercise physical duplicate SDK copies",
    );
  }
  const h = await nativePi();
  let recording;
  try {
    assert.equal(globalThis.fetch, installedFetch);
    const client = new SovaraClient({
      url: h.server.url,
      projectName: "application",
      autoInstrumentation: { providerHttp: true, mcp: false },
    });
    recording = await client.startRecording("Application parent scope", {
      captureLogs: false,
    });
    await Promise.all([
      recording.run(async () => {
        const response = await fetch(h.server.url + "/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "application",
            messages: [{ role: "user", content: "Application request" }],
            stream: true,
          }),
        });
        await response.text();
      }),
      h.session.prompt(
        "Extension request concurrent with the application recording",
      ),
    ]);
    assert.equal(recording.state, "active");
    await recording.finish();
    const prepares = h.server.calls.filter((call) =>
      call.path.endsWith("/prepare"),
    );
    assert.equal(prepares.length, 2);
    assert.equal(
      prepares.filter((call) => call.body.trace_id === recording!.traceId)
        .length,
      1,
    );
    assert.equal(new Set(prepares.map((call) => call.body.trace_id)).size, 2);
    assert.equal(
      h.server.calls.filter((call) => call.path.endsWith("/finalize")).length,
      2,
    );
    assert.equal(
      h.server.calls.filter((call) => call.path === "/v1/chat/completions")
        .length,
      2,
    );
    assert.equal(globalThis.fetch, installedFetch);
  } finally {
    await recording?.finish();
    await h.close();
  }
});
