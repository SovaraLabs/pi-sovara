import { test } from "node:test";
import assert from "node:assert/strict";
import { SovaraClient } from "../src/client.ts";
import { Recorder } from "../src/recorder.ts";
import { fixtureServer } from "./helpers.ts";

test("negotiation fails closed on missing, incompatible and malformed contracts", async () => {
  const server = await fixtureServer();
  try {
    const client = new SovaraClient(server.config);
    await assert.rejects(client.register("one", "/repo"), /not_connected/);
    for (const value of [undefined, [5], [4, 4], ["4"], []]) {
      server.versions(value);
      await assert.rejects(client.connect(), /incompatible/);
      await assert.rejects(client.register("one", "/repo"), /not_connected/);
    }
    assert.equal(
      server.calls.filter((c) => c.path === "/runner/register").length,
      0,
    );
  } finally {
    await server.close();
  }
});

test("records resume, retrieval, provider retries, parallel tools, and exact turns", async () => {
  const server = await fixtureServer();
  try {
    const client = new SovaraClient(server.config);
    await client.connect();
    const recorder = new Recorder(
      client,
      server.config,
      "session-one",
      "/repo",
    );
    await recorder.start("first prompt");
    await recorder.retrieve("current model input");
    recorder.setContext([
      { role: "user", content: "with lessons", timestamp: 1 },
    ]);
    await recorder.beginGeneration(
      { messages: ["actual provider payload"] },
      { id: "test", provider: "mock" },
    );
    await recorder.beginGeneration(
      { messages: ["retried payload"] },
      { id: "test", provider: "mock" },
    );
    await recorder.endGeneration({
      role: "assistant",
      api: "openai-completions",
      provider: "test",
      model: "test",
      timestamp: 1,
      content: [{ type: "text", text: "answer" }],
      usage: {
        input: 10,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    });
    await Promise.all([
      recorder.beginTool("a", "read", { path: "a" }),
      recorder.beginTool("b", "edit", { path: "b" }),
    ]);
    await recorder.endTool("b", "failed", true);
    await recorder.endTool("a", "ok", false);
    await recorder.close();
    await recorder.start("resumed prompt");
    await recorder.close();
    const registrations = server.calls.filter(
      (c) => c.path === "/runner/register",
    );
    assert.deepEqual(
      registrations.map((c) => c.body.run_id),
      ["pi:session-one", "pi:session-one"],
    );
    const preparations = server.calls.filter((c) =>
      c.path.endsWith("/prepare"),
    );
    assert.equal(preparations.length, 5);
    assert.ok(
      preparations.every((c) => c.body.prepare_runtime_lessons === false),
    );
    const finalized = server.calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(finalized.length, 5);
    assert.equal(finalized.filter((c) => c.body.status === "error").length, 2);
    for (const finish of finalized) {
      const prepare = preparations.find(
        (c) => c.body.step_uuid === finish.body.step_uuid,
      )!;
      assert.equal(finish.body.turn_id, prepare.body.turn_id);
      assert.equal(finish.headers["x-sovara-run-token"], "recording-secret");
      assert.equal(finish.headers["x-sovara-agent-token"], undefined);
    }
    const llm = JSON.parse(preparations[2].body.input_json).raw;
    assert.equal(
      llm.lesson_retrieval.step_uuid,
      preparations[0].body.step_uuid,
    );
    assert.equal(llm.lesson_retrieval.query, undefined);
    assert.deepEqual(llm.provider_payload.messages, ["retried payload"]);
  } finally {
    await server.close();
  }
});

test("interrupted work is finalized and errors never expose response bodies", async () => {
  const server = await fixtureServer();
  try {
    const client = new SovaraClient(server.config);
    await client.connect();
    const recorder = new Recorder(
      client,
      server.config,
      "interrupted",
      "/repo",
    );
    await recorder.start("work");
    await recorder.beginGeneration({}, undefined);
    await recorder.beginTool("a", "read", {});
    await recorder.close("Cancelled");
    assert.equal(
      server.calls.filter(
        (c) => c.path.endsWith("/finalize") && c.body.status === "error",
      ).length,
      2,
    );
    server.reject("/runner/register");
    await assert.rejects(client.register("two", "/repo"), (error) => {
      assert.match(String(error), /503/);
      assert.doesNotMatch(String(error), /PRIVATE/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("failed retry finalization does not suppress the next attempt", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(
    client,
    server.config,
    "retry-failure",
    "/repo",
  );
  try {
    await client.connect();
    await recorder.start("task");
    await recorder.beginGeneration({ attempt: 1 }, undefined);
    server.reject("/internal/runner/llm/finalize");
    await recorder.beginGeneration({ attempt: 2 }, undefined);
    assert.equal(recorder.takeExportErrors().length, 1);
    assert.equal(
      server.calls.filter((call) => call.path.endsWith("/prepare")).length,
      2,
    );
    server.reject("");
    await recorder.close();
    const finalized = server.calls.filter((call) =>
      call.path.endsWith("/finalize"),
    );
    assert.equal(
      JSON.parse(finalized.at(-1)!.body.input_json).raw.provider_payload
        .attempt,
      2,
    );
  } finally {
    await server.close();
  }
});

test("run output survives a missing model step and failed interrupted-step export", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(
    client,
    server.config,
    "output-failure",
    "/repo",
  );
  try {
    await client.connect();
    await recorder.start("task");
    server.reject("/internal/runner/llm/prepare");
    await assert.rejects(recorder.beginGeneration({}, undefined));
    server.reject("");
    await recorder.endGeneration({
      role: "assistant",
      content: [{ type: "text", text: "successful answer" }],
      stopReason: "stop",
    } as Parameters<Recorder["endGeneration"]>[0]);
    await recorder.beginTool("pending", "read", {});
    server.reject("/internal/runner/llm/finalize");
    await recorder.close();
    assert.equal(recorder.takeExportErrors().length, 1);
    const output = server.calls.find(
      (call) => call.path === "/runner/run-io" && call.body.kind === "output",
    );
    assert.equal(JSON.parse(output!.body.value)[0].text, "successful answer");
    assert.equal(server.calls.at(-1)!.path, "/runner/deregister");
  } finally {
    await server.close();
  }
});

test(
  "cancellation during retry finalization prevents a new preparation",
  { timeout: 3000 },
  async () => {
    const server = await fixtureServer();
    const client = new SovaraClient(server.config);
    const recorder = new Recorder(
      client,
      server.config,
      "retry-cancel",
      "/repo",
    );
    const controller = new AbortController();
    try {
      await client.connect();
      await recorder.start("task", controller.signal);
      await recorder.beginGeneration({}, undefined, controller.signal);
      const reached = server.blockNext("/internal/runner/llm/finalize");
      const rejected = assert.rejects(
        recorder.beginGeneration({}, undefined, controller.signal),
        { name: "AbortError" },
      );
      await reached;
      controller.abort();
      await rejected;
      assert.equal(
        server.calls.filter((call) => call.path.endsWith("/prepare")).length,
        1,
      );
      await recorder.close();
    } finally {
      await server.close();
    }
  },
);

test(
  "cancelled close shares one cleanup deadline across all exports",
  { timeout: 3000 },
  async () => {
    const server = await fixtureServer();
    const signals: AbortSignal[] = [];
    let closing = false;
    const fetcher: typeof fetch = async (input, init) => {
      if (closing) {
        signals.push(init!.signal!);
        const signal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      }
      return fetch(input, init);
    };
    const client = new SovaraClient(server.config, fetcher);
    const recorder = new Recorder(
      client,
      server.config,
      "close-cancel",
      "/repo",
    );
    const controller = new AbortController();
    try {
      await client.connect();
      await recorder.start("task"); // Pi exposes the signal only after before_agent_start.
      await recorder.beginTool("a", "read", {}, undefined, controller.signal);
      closing = true;
      controller.abort();
      await recorder.close();
      assert.equal(
        signals.length,
        1,
        "later exports see the expired shared budget before sending",
      );
      assert.equal(
        recorder.takeExportErrors().length,
        3,
        "pending step, output and deregister all report failure",
      );
    } finally {
      await server.close();
    }
  },
);

test("model display keeps normalized content without duplicating provider and retrieval evidence", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(client, server.config, "display", "/repo");
  try {
    await client.connect();
    await recorder.start("task");
    const marker = "unique-context-marker";
    const messages = await recorder.prepareContext([
      { role: "user", content: marker, timestamp: 1 },
    ]);
    await recorder.beginGeneration({ messages }, undefined);
    const preparation = server.calls
      .filter((call) => call.path.endsWith("/prepare"))
      .at(-1)!;
    const { raw, to_show } = JSON.parse(preparation.body.input_json);
    assert.deepEqual(to_show.body.messages, messages);
    assert.deepEqual(raw.provider_payload.messages, messages);
    assert.equal(to_show.provider_payload, undefined);
    assert.equal(to_show.lesson_retrieval, undefined);
    assert.equal(raw.lesson_retrieval.query, undefined);
    assert.equal(raw.lesson_retrieval.result, undefined);
    assert.deepEqual(raw.lesson_retrieval.injected_lesson_ids, ["lesson-1"]);
    assert.equal(preparation.body.input_json.split(marker).length - 1, 3);
    const retrieval = server.calls.find((call) =>
      call.path.endsWith("/finalize"),
    )!;
    assert.equal(raw.lesson_retrieval.step_uuid, retrieval.body.step_uuid);
    await recorder.close();
  } finally {
    await server.close();
  }
});
