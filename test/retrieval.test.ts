import { test } from "node:test";
import assert from "node:assert/strict";
import { SovaraClient } from "../src/client.ts";
import { Recorder, withUsage } from "../src/recorder.ts";
import { RetrievalSuffix } from "../src/lessons.ts";
import { fixtureServer } from "./helpers.ts";

test("already cancelled retrieval sends no requests", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(client, server.config, "session", "/repo");
  try {
    await client.connect();
    await recorder.start("task");
    const count = server.calls.length;
    await assert.rejects(recorder.retrieve("task", AbortSignal.abort()), {
      name: "AbortError",
    });
    assert.equal(server.calls.length, count);
  } finally {
    await recorder.close();
    await server.close();
  }
});

for (const blockedPath of ["/internal/lessons/retrieve"]) {
  test(
    `cancellation interrupts ${blockedPath}`,
    { timeout: 3000 },
    async () => {
      const server = await fixtureServer();
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let intercepted = false;
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith(blockedPath) && !intercepted) {
          intercepted = true;
          reached();
          return new Promise<Response>((_resolve, reject) => {
            assert.ok(init?.signal);
            const signal = init.signal;
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
      const recorder = new Recorder(client, server.config, "session", "/repo");
      try {
        await client.connect();
        await recorder.start("task");
        const controller = new AbortController();
        const rejected = assert.rejects(
          recorder.retrieve("task", controller.signal),
          { name: "AbortError" },
        );
        await started;
        controller.abort();
        await rejected;
        assert.ok(intercepted);
      } finally {
        await recorder.close();
        await server.close();
      }
    },
  );
}

test("suffix credentials are masked before both retrieval and trace serialization", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(client, server.config, "session", "/repo");
  const query = new RetrievalSuffix().context([
    { role: "user", content: "task", timestamp: 1 },
    {
      role: "assistant",
      api: "openai-completions",
      provider: "test",
      model: "test",
      timestamp: 2,
      content: [
        {
          type: "toolCall",
          id: "a",
          name: "service",
          arguments: {
            nested: { api_key: "synthetic-provider-secret" },
            safe: "useful context",
          },
        },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    },
  ]);
  try {
    await client.connect();
    await recorder.start("task");
    await recorder.retrieve(query.context);
    for (const call of server.calls.filter((c) =>
      /retrieve|prepare|finalize/.test(c.path),
    )) {
      assert.doesNotMatch(
        JSON.stringify(call.body),
        /synthetic-provider-secret/,
      );
      assert.match(JSON.stringify(call.body), /useful context|deterministic/);
    }
    assert.doesNotMatch(query.context, /synthetic-provider-secret/);
  } finally {
    await recorder.close();
    await server.close();
  }
});

test("retrieval rejects malformed responses at the boundary", async () => {
  const valid = {
    lessons: [{ lesson_id: "id", title: "title", content: "body" }],
    rendered_lessons_block: "body",
    retrieval_status: "complete",
  };
  let payload: unknown = valid;
  const fetcher: typeof fetch = async (input) =>
    Response.json(
      String(input).endsWith("/health")
        ? {
            compatibility: {
              component: "exec-server",
              contracts: { "runner-api": [4] },
            },
          }
        : payload,
    );
  const client = new SovaraClient(
    {
      projectName: "test",
      execUrl: "https://fixture.invalid",
      authHeaders: {},
      autoStartLocal: false,
    },
    fetcher,
  );
  await client.connect();
  const scope = {
    recording: {
      run_id: "r",
      recording_id: "rec",
      run_write_token: "token",
      project_id: "p",
    },
    turnId: "turn",
  };
  for (payload of [
    null,
    [],
    { ...valid, retrieval_status: undefined },
    { ...valid, retrieval_status: "unexpected" },
    { ...valid, warning_message: { malformed: true } },
    { ...valid, error_message: 123 },
    { ...valid, model_used: [] },
    { ...valid, lessons: [{ ...valid.lessons[0], summary: 12 }] },
    { ...valid, lessons: [null] },
    { ...valid, lessons: [{ lesson_id: "id", content: "body" }] },
    { ...valid, lessons: [{ lesson_id: "", title: "t", content: "body" }] },
  ]) {
    await assert.rejects(client.retrieve(scope, "query"), /invalid_/);
  }
  payload = {
    ...valid,
    debug_blob: "unneeded",
    lessons: [{ ...valid.lessons[0], debug_blob: "unneeded" }],
  };
  assert.deepEqual(await client.retrieve(scope, "query"), valid);
  payload = {
    ...valid,
    warning_message: "Missing Fast Helper Model token",
    error_message: null,
  };
  assert.deepEqual(await client.retrieve(scope, "query"), {
    ...valid,
    warning_message: "Missing Fast Helper Model [REDACTED]",
  });
});

test("usage normalization only copies numeric fields", () => {
  assert.deepEqual(withUsage({ usage: { input: "bad", output: 2 } }), {
    usage: { input: "bad", output: 2, output_tokens: 2 },
  });
  assert.equal(withUsage(null), null);
});

test("suffix sanitizes escaped integration secrets before query serialization", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(
    client,
    server.config,
    "suffix-secret",
    "/repo",
  );
  const secret = 'secret"with\na-newline';
  client.protect(secret);
  try {
    await client.connect();
    await recorder.start("task");
    await recorder.prepareContext([
      { role: "user", content: secret, timestamp: 1 },
    ]);
    const query = server.calls.find((call) => call.path.endsWith("/retrieve"))!
      .body.raw_context;
    const message = JSON.parse(JSON.parse(query).suffix[0].text);
    assert.equal(message.content, "[REDACTED]");
    await recorder.close();
  } finally {
    await server.close();
  }
});

test("LLM metadata contains only injected lessons and the exact bounded text", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(
    client,
    server.config,
    "bounded-lessons",
    "/repo",
  );
  const lesson = {
    lesson_id: "one",
    title: "Portfolio restrictions",
    summary: "Limit sector exposure.",
    content: "No more than 5% per sector.",
  };
  server.retrieval({
    lessons: [
      lesson,
      lesson,
      { ...lesson, lesson_id: "oversized", content: "x".repeat(13000) },
    ],
    rendered_lessons_block: "Server rendering is not what Pi injects.",
    retrieval_status: "complete",
    model_used: "helper",
    latency_tier: "HIGH",
  });
  try {
    await client.connect();
    await recorder.start("task");
    const messages = await recorder.prepareContext([
      { role: "user", content: "Add Micron?", timestamp: 1 },
    ]);
    await recorder.beginGeneration({ messages }, undefined);
    await recorder.close();
    const calls = server.calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.api_type, "pi.llm");
    const metadata = calls[0].body.lesson_metadata;
    assert.deepEqual(metadata.applied_lessons, [lesson]);
    assert.equal(
      metadata.rendered_lessons_block,
      (messages.at(-1) as any).content,
    );
    assert.match(metadata.warning_message, /injection size limit/);
    assert.equal(metadata.model, "helper");
    assert.equal(metadata.latency_tier, "HIGH");
    assert.ok(metadata.retrieval_latency_ms >= 0);
    assert.equal(
      JSON.parse(calls[0].body.input_json).raw.lesson_retrieval,
      undefined,
    );
    assert.equal(
      server.calls.filter((c) => c.path.endsWith("/prepare")).length,
      1,
    );
  } finally {
    await server.close();
  }
});

test("each retry and interrupted attempt keeps its own lesson snapshot", async () => {
  const server = await fixtureServer();
  const client = new SovaraClient(server.config);
  const recorder = new Recorder(
    client,
    server.config,
    "retry-lessons",
    "/repo",
  );
  try {
    await client.connect();
    await recorder.start("task");
    await recorder.prepareContext([
      { role: "user", content: "first", timestamp: 1 },
    ]);
    await recorder.beginGeneration({ attempt: 1 }, undefined);
    server.retrieval({
      lessons: [
        { lesson_id: "second", title: "Second", content: "New guidance" },
      ],
      rendered_lessons_block: "",
      retrieval_status: "complete",
    });
    await recorder.prepareContext([
      { role: "user", content: "second", timestamp: 2 },
    ]);
    await recorder.beginGeneration({ attempt: 2 }, undefined);
    await recorder.beginGeneration({ attempt: 3 }, undefined); // Provider retry without new retrieval.
    await recorder.close("Cancelled");
    const calls = server.calls.filter((c) => c.path.endsWith("/finalize"));
    assert.deepEqual(
      calls.map((c) => c.body.lesson_metadata.applied_lessons[0].lesson_id),
      ["lesson-1", "second", "second"],
    );
    assert.deepEqual(
      calls.map((c) => JSON.parse(c.body.error_json).type),
      ["ProviderRetry", "ProviderRetry", "Cancelled"],
    );
    assert.equal(new Set(calls.map((c) => c.body.step_uuid)).size, 3);
    await recorder.start("next turn");
    await recorder.beginGeneration({}, undefined);
    await recorder.close();
    assert.equal(
      server.calls.filter((c) => c.path.endsWith("/finalize")).at(-1)!.body
        .lesson_metadata,
      null,
    );
  } finally {
    await server.close();
  }
});

for (const failure of ["http", "response"] as const) {
  test(`${failure} retrieval failure cannot apply stale or returned lessons to the next LLM`, async () => {
    const server = await fixtureServer();
    const client = new SovaraClient(server.config);
    const recorder = new Recorder(
      client,
      server.config,
      "failed-lessons",
      "/repo",
    );
    try {
      await client.connect();
      await recorder.start("task");
      await recorder.prepareContext([
        { role: "user", content: "first", timestamp: 1 },
      ]);
      if (failure === "http") server.reject("/internal/lessons/retrieve");
      else
        server.retrieval({
          lessons: [
            {
              lesson_id: "invalid",
              title: "Do not inject",
              content: "not usable",
            },
          ],
          rendered_lessons_block: "not usable",
          retrieval_status: "failed",
          error_message: "selection_failed",
        });
      const messages = [
        { role: "user" as const, content: "second", timestamp: 2 },
      ];
      if (failure === "http")
        await assert.rejects(
          recorder.prepareContext(messages),
          /request_failed/,
        );
      else assert.deepEqual(await recorder.prepareContext(messages), messages);
      await recorder.beginGeneration({}, undefined);
      await recorder.endGeneration({
        role: "assistant",
        content: [],
        stopReason: "stop",
      } as any);
      await recorder.close();
      const call = server.calls.find((c) => c.path.endsWith("/finalize"))!;
      assert.equal(call.body.status, "success");
      assert.equal(call.body.lesson_metadata.retrieval_status, "failed");
      assert.deepEqual(call.body.lesson_metadata.applied_lessons, []);
      assert.equal(call.body.lesson_metadata.rendered_lessons_block, "");
      assert.ok(call.body.lesson_metadata.error_message);
      assert.deepEqual(
        JSON.parse(call.body.input_json).raw.body.messages,
        messages,
      );
    } finally {
      await server.close();
    }
  });
}
