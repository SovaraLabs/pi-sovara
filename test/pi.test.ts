import { test } from "node:test";
import assert from "node:assert/strict";
import { completion } from "./helpers.ts";
import { nativePi } from "./nativePi.ts";
import { setTimeout as delay } from "node:timers/promises";

test("real Pi native provider sends one prepared request per tool-loop call without retaining lessons", async () => {
  const h = await nativePi();
  let requests = 0;
  h.server.provider((_body, response) =>
    completion(
      response,
      "ACK",
      requests++ === 0
        ? { name: "read", arguments: { path: "input.txt" } }
        : undefined,
    ),
  );
  try {
    await h.session.prompt("Inspect input.txt and explain how to test it.");
    assert.deepEqual(h.errors, []);
    const calls = h.server.calls,
      native = calls.filter((c) => c.path === "/v1/chat/completions"),
      prepares = calls.filter((c) => c.path.endsWith("/prepare")),
      finals = calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(native.length, 2);
    assert.equal(
      prepares.filter((c) => c.body.api_type === "httpx.Client.send").length,
      2,
    );
    assert.equal(finals.filter((c) => c.body.step_kind === "llm").length, 2);
    assert.equal(finals.filter((c) => c.body.step_kind === "tool").length, 1);
    assert.equal(
      calls.filter((c) => c.path === "/internal/lessons/retrieve").length,
      0,
    );
    for (const request of native) {
      assert.equal(
        request.headers.authorization,
        "Bearer CONTROLLED_PROVIDER_KEY",
      );
      assert.equal(
        request.body.messages.filter((m: any) =>
          String(m.content).includes("TEMPORARY_LESSON_"),
        ).length,
        1,
      );
    }
    assert.doesNotMatch(
      JSON.stringify(h.session.messages),
      /TEMPORARY_LESSON_/,
    );
    assert.doesNotMatch(
      JSON.stringify(prepares.map((c) => c.body)),
      /CONTROLLED_PROVIDER_KEY|TEMPORARY_LESSON_/,
    );
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    assert(
      finals.every((c) => c.body.status !== "error"),
      JSON.stringify(
        finals.map((c) => ({
          api: c.body.api_type,
          status: c.body.status,
          error: c.body.error_json,
        })),
      ),
    );
  } finally {
    await h.close();
  }
});

test("actual extension reload restores and rewraps one native provider without duplicate steps", async () => {
  const h = await nativePi();
  try {
    await h.session.prompt("Before reload");
    await h.session.reload();
    await h.session.prompt("After reload");
    const calls = h.server.calls;
    assert.deepEqual(h.errors, []);
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      2,
    );
    assert.equal(calls.filter((c) => c.path.endsWith("/prepare")).length, 2);
    assert.equal(calls.filter((c) => c.path.endsWith("/finalize")).length, 2);
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      2,
    );
    assert.equal(
      new Set(
        calls
          .filter((c) => c.path === "/runner/register")
          .map((c) => c.body.trace_id),
      ).size,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(h.session.messages),
      /TEMPORARY_LESSON_/,
    );
  } finally {
    await h.close();
  }
});

test("ordinary native cancellation stops the provider and finalizes exactly once", async () => {
  const h = await nativePi();
  let entered!: () => void,
    closed = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    h.server.provider((_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      response.once("close", () => {
        closed = true;
      });
      entered();
    });
    const work = h.session.prompt("Controlled slow call");
    await started;
    assert.equal(h.session.isIdle, false);
    await h.session.abort();
    await work;
    for (let i = 0; i < 50 && !closed; i++) await delay(10);
    assert.equal(closed, true);
    const calls = h.server.calls;
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    const finals = calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(finals.length, 1);
    assert.equal(finals[0].body.status, "error");
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    assert.equal(h.session.messages.at(-1)?.role, "assistant");
  } finally {
    await h.close();
  }
});

test("failed SDK preparation and registration never repeat or suppress Pi's native call", async () => {
  for (const path of ["/internal/runner/llm/prepare", "/runner/register"]) {
    const h = await nativePi();
    try {
      h.server.reject(path);
      await h.session.prompt("Native call survives recording unavailability");
      assert.equal(
        h.server.calls.filter((c) => c.path === "/v1/chat/completions").length,
        1,
      );
      assert.equal(h.session.getLastAssistantText(), "ACK");
      assert.equal(
        h.server.calls.filter((c) => c.path.endsWith("/finalize")).length,
        0,
      );
      assert.doesNotMatch(JSON.stringify(h.errors), /PRIVATE ERROR PAYLOAD/);
    } finally {
      await h.close();
    }
  }
});

test("a virtual model routes through the current native provider without an extra observation", async () => {
  const h = await nativePi();
  try {
    let routed = 0;
    h.runtime.registerVirtualModel({
      provider: "sovara-test",
      id: "virtual",
      name: "Controlled router",
      route(request) {
        routed++;
        assert.equal(request.signal?.aborted, false);
        return {
          model: h.runtime.getModel("sovara-test", "synthetic")!,
          thinkingLevel: "off",
        };
      },
    });
    await h.session.setModel(h.runtime.getModel("sovara-test", "virtual")!);
    await h.session.prompt(
      "Route this task through the configured physical model.",
    );
    assert.equal(routed, 1);
    assert.equal(
      h.server.calls.filter((call) => call.path === "/v1/chat/completions")
        .length,
      1,
    );
    const prepared = h.server.calls.filter((call) =>
      call.path.endsWith("/prepare"),
    );
    assert.equal(prepared.length, 1);
    assert.equal(
      JSON.parse(prepared[0]!.body.input_json).raw.body.model,
      "synthetic",
    );
    assert.equal(
      h.server.calls.filter((call) => call.path.endsWith("/finalize")).length,
      1,
    );
    assert.equal(h.session.getLastAssistantText(), "ACK");
  } finally {
    await h.close();
  }
});
