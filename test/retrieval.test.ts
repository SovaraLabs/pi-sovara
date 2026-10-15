import { test } from "node:test";
import assert from "node:assert/strict";
import { SovaraClient } from "../src/client.ts";
import { Recorder, withUsage } from "../src/recorder.ts";
import { RetrievalSuffix } from "../src/lessons.ts";
import { fixtureServer } from "./helpers.ts";

for (const failedPath of [
  "/internal/runner/llm/prepare",
  "/internal/runner/llm/finalize",
]) {
  test(`retrieval survives export failure at ${failedPath}`, async () => {
    const server = await fixtureServer();
    const client = new SovaraClient(server.config);
    const recorder = new Recorder(client, server.config, "session", "/repo");
    try {
      await client.connect();
      await recorder.start("task");
      server.reject(failedPath);
      const result = await recorder.retrieve("task");
      assert.equal(result.lessons.length, 1);
      assert.ok(recorder.retrievalExportError);
      assert.equal(recorder.retrieval?.status, undefined);
      assert.equal(
        server.calls.filter((c) => c.path.endsWith("/finalize")).length,
        failedPath.endsWith("/finalize") ? 1 : 0,
      );
    } finally {
      server.reject("");
      await recorder.close();
      await server.close();
    }
  });
}

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

for (const blockedPath of [
  "/internal/runner/llm/prepare",
  "/internal/lessons/retrieve",
  "/internal/runner/llm/finalize",
]) {
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
    { ...valid, lessons: [null] },
    { ...valid, lessons: [{ lesson_id: "id", content: "body" }] },
    { ...valid, lessons: [{ lesson_id: "", title: "t", content: "body" }] },
  ]) {
    await assert.rejects(client.retrieve(scope, "query"), /invalid_/);
  }
  payload = valid;
  assert.deepEqual(await client.retrieve(scope, "query"), valid);
});

test("usage normalization only copies numeric fields", () => {
  assert.deepEqual(withUsage({ usage: { input: "bad", output: 2 } }), {
    usage: { input: "bad", output: 2, output_tokens: 2 },
  });
  assert.equal(withUsage(null), null);
});

test(
  "cancelled retrieval cleanup has a separate one-second deadline",
  { timeout: 3000 },
  async () => {
    const server = await fixtureServer();
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/retrieve")) {
        controller.abort();
        throw controller.signal.reason;
      }
      if (String(input).endsWith("/finalize")) {
        cleanupSignal = init?.signal ?? undefined;
        assert.ok(cleanupSignal);
        assert.equal(cleanupSignal.aborted, false);
        const signal = cleanupSignal;
        return new Promise<Response>((_resolve, reject) => {
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
      await assert.rejects(recorder.retrieve("task", controller.signal), {
        name: "AbortError",
      });
      assert.equal(cleanupSignal?.aborted, true);
      assert.equal(
        (recorder.retrievalExportError as Error).name,
        "TimeoutError",
      );
    } finally {
      await recorder.close();
      await server.close();
    }
  },
);
