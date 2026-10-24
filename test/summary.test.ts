import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { completion } from "./helpers.ts";
import { nativePi } from "./nativePi.ts";

async function history(h: Awaited<ReturnType<typeof nativePi>>) {
  await h.session.prompt("Controlled original task ".repeat(100));
  await h.session.prompt("Controlled continuation ".repeat(100));
  return h.session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user")!
    .id;
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Expected completion before deadline");
}

test("slow real tree summary stays scoped through native request and settles after success", async () => {
  const h = await nativePi();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const target = await history(h),
      before = h.server.calls.length;
    h.server.provider((_body, response) => {
      entered();
      release = () => {
        if (!response.writableEnded)
          completion(response, "Controlled branch summary");
      };
    });
    const work = h.session.navigateTree(target, { summarize: true });
    await started;
    assert.equal(h.session.isIdle, false);
    await delay(150);
    assert.equal(
      h.server.calls
        .slice(before)
        .filter((c) => c.path === "/runner/deregister").length,
      0,
    );
    release();
    await work;
    assert.equal(h.session.isIdle, true);
    const calls = h.server.calls.slice(before);
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    assert.equal(calls.filter((c) => c.path.endsWith("/finalize")).length, 1);
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    assert(
      calls
        .filter((c) => c.path.endsWith("/prepare"))
        .every((c) => c.body.api_type === "httpx.Client.send"),
    );
    assert.doesNotMatch(
      JSON.stringify(h.session.messages),
      /TEMPORARY_LESSON_/,
    );
  } finally {
    release?.();
    await h.close();
  }
});

test("real failed tree summary has no success event and still closes at public idle", async () => {
  const h = await nativePi();
  try {
    const target = await history(h),
      before = h.server.calls.length;
    h.server.provider((_body, response) =>
      response
        .writeHead(400)
        .end(
          JSON.stringify({
            error: {
              message: "Controlled provider failure",
              type: "invalid_request_error",
            },
          }),
        ),
    );
    await assert.rejects(h.session.navigateTree(target, { summarize: true }));
    assert.equal(h.session.isIdle, true);
    await waitFor(() =>
      h.server.calls.slice(before).some((c) => c.path === "/runner/deregister"),
    );
    const calls = h.server.calls.slice(before);
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      1,
    );
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    h.server.provider((_body, response) => completion(response));
    await h.session.prompt("Continue after the failed summary");
    assert.equal(
      h.server.calls.filter((c) => c.path === "/runner/register").length,
      h.server.calls.filter((c) => c.path === "/runner/deregister").length,
    );
  } finally {
    await h.close();
  }
});

test("real branch-summary abort closes its own recording without waiting for another turn", async () => {
  const h = await nativePi();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const target = await history(h),
      before = h.server.calls.length;
    h.server.provider((_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      entered();
    });
    const work = h.session.navigateTree(target, { summarize: true });
    await started;
    assert.equal(h.session.isIdle, false);
    h.session.abortBranchSummary();
    await work;
    await waitFor(() =>
      h.server.calls.slice(before).some((c) => c.path === "/runner/deregister"),
    );
    const calls = h.server.calls.slice(before);
    assert.equal(calls.filter((c) => c.path.endsWith("/finalize")).length, 1);
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("manual compaction records only its actual native request", async () => {
  const h = await nativePi();
  try {
    await history(h);
    const before = h.server.calls.length;
    await h.session.compact();
    const calls = h.server.calls.slice(before);
    assert(calls.some((c) => c.path === "/v1/chat/completions"));
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      calls.filter((c) => c.path.endsWith("/finalize")).length,
    );
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    assert(
      calls
        .filter((c) => c.path.endsWith("/prepare"))
        .every((c) => c.body.api_type === "httpx.Client.send"),
    );
  } finally {
    await h.close();
  }
});

test("branch routing failure before a provider call closes the empty summary and preserves the failure", async () => {
  const h = await nativePi();
  try {
    const target = await history(h),
      before = h.server.calls.length;
    const failure = new Error("Controlled pre-provider routing failure");
    h.runtime.registerVirtualModel({
      provider: "sovara-test",
      id: "route-failure",
      name: "Route failure",
      route() {
        throw failure;
      },
    });
    await h.session.setModel(
      h.runtime.getModel("sovara-test", "route-failure")!,
    );
    await assert.rejects(
      h.session.navigateTree(target, { summarize: true }),
      (error) => error === failure,
    );
    await waitFor(() =>
      h.server.calls.slice(before).some((c) => c.path === "/runner/deregister"),
    );
    const calls = h.server.calls.slice(before);
    assert.equal(h.session.isIdle, true);
    assert.equal(
      calls.filter((c) => c.path === "/v1/chat/completions").length,
      0,
    );
    assert.equal(calls.filter((c) => c.path.endsWith("/prepare")).length, 0);
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    await h.session.setModel(h.runtime.getModel("sovara-test", "synthetic")!);
    await h.session.prompt("Continue after pre-provider failure");
    assert.equal(
      h.server.calls.filter((c) => c.path === "/runner/register").length,
      h.server.calls.filter((c) => c.path === "/runner/deregister").length,
    );
  } finally {
    await h.close();
  }
});

test("native tree-summary retry keeps both attempts in the same live summary scope", async () => {
  const h = await nativePi({
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 10,
      provider: { maxRetries: 0 },
    },
  });
  try {
    const target = await history(h),
      before = h.server.calls.length;
    let attempts = 0;
    h.server.provider((_body, response) => {
      if (++attempts === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'data: {"id":"partial","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        );
        setTimeout(() => response.destroy(), 20);
      } else completion(response, "Successful retried summary");
    });
    await h.session.navigateTree(target, { summarize: true });
    const calls = h.server.calls.slice(before),
      finals = calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(attempts, 2);
    assert.equal(calls.filter((c) => c.path === "/runner/register").length, 1);
    assert.equal(calls.filter((c) => c.path === "/runner/turns").length, 1);
    assert.equal(
      calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
    assert.deepEqual(
      finals.map((c) => c.body.status ?? "success"),
      ["error", "success"],
    );
    const prepares = calls.filter((c) => c.path.endsWith("/prepare"));
    assert.equal(new Set(prepares.map((c) => c.body.turn_id)).size, 1);
    assert(
      prepares.every((c) => !c.body.input_json.includes("TEMPORARY_LESSON_")),
    );
  } finally {
    await h.close();
  }
});

test("automatic compaction borrows the live recording and leaves the ordinary turn owned by Pi", async () => {
  const h = await nativePi();
  try {
    await history(h);
    h.settings.setCompactionEnabled(true);
    const before = h.server.calls.length;
    let requests = 0;
    h.server.provider((_body, response) => {
      if (++requests === 1) {
        response.setHeader("content-type", "text/event-stream");
        response.end(
          `data: ${JSON.stringify({ id: "threshold", choices: [{ index: 0, delta: { role: "assistant", content: "Completed ordinary task" }, finish_reason: "stop" }], usage: { prompt_tokens: 199950, completion_tokens: 5, total_tokens: 199955 } })}\n\ndata: [DONE]\n\n`,
        );
      } else completion(response, "Controlled automatic summary");
    });
    await h.session.prompt(
      "Trigger the native automatic context threshold after this reply.",
    );
    const calls = h.server.calls.slice(before);
    assert.equal(requests, 2);
    assert.equal(
      calls.filter((call) => call.path === "/runner/register").length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.path === "/runner/turns").length,
      2,
    );
    assert.equal(
      calls.filter((call) => call.path === "/runner/deregister").length,
      1,
    );
    const prepares = calls.filter((call) => call.path.endsWith("/prepare"));
    assert.equal(
      new Set(prepares.map((call) => call.headers["x-sovara-trace-token"]))
        .size,
      1,
    );
    assert.equal(new Set(prepares.map((call) => call.body.turn_id)).size, 2);
    assert.equal(
      calls.filter((call) => call.path.endsWith("/finalize")).length,
      2,
    );
    assert(
      h.session.sessionManager
        .getEntries()
        .some((entry) => entry.type === "compaction"),
    );
    assert.doesNotMatch(
      JSON.stringify(h.session.messages),
      /TEMPORARY_LESSON_/,
    );
    assert.equal(h.session.isIdle, true);
  } finally {
    await h.close();
  }
});
