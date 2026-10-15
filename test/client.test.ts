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
    recorder.context = [{ role: "user", content: "with lessons" }];
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
      content: "answer",
      usage: { input: 10 },
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
    assert.equal(llm.lesson_retrieval.query, "current model input");
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
