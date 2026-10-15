import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { fixtureServer } from "./helpers.ts";

async function harness(parent?: string) {
  const backend = await fixtureServer();
  const cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  await mkdir(join(cwd, ".pi"));
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
  };
  process.env.SOVARA_EXEC_SERVER_URL = backend.config.execUrl;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  if (parent)
    process.env.SOVARA_PI_PARENT = parent.replace(
      "BACKEND_URL",
      backend.config.execUrl,
    );
  else delete process.env.SOVARA_PI_PARENT;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let entries: any[] = [];
  let sessionId = "session-1";
  const statuses: string[] = [];
  const notifications: string[] = [];
  const commands = new Map<string, any>();
  const api = {
    on(name: string, callback: any) {
      handlers.set(name, callback);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    signal: undefined as AbortSignal | undefined,
    model: { id: "test", provider: "test" },
    ui: {
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getHeader: () => ({}),
    },
  };
  extension(api);
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return {
    backend,
    cwd,
    statuses,
    notifications,
    command: (name: string) => commands.get(name).handler("", ctx),
    emit,
    ctx,
    async config(projectName: string) {
      await writeFile(
        join(cwd, ".pi", "sovara.json"),
        JSON.stringify({ projectName }),
      );
    },
    newSession() {
      entries = [];
      sessionId = "session-2";
    },
    async start() {
      await emit("session_start", { reason: "startup" });
    },
    async prompt() {
      await emit("before_agent_start", {
        messageType: "user",
        prompt: "task",
        systemPromptOptions: { sections: {} },
      });
    },
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await backend.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("project changes apply to new sessions while resume keeps its binding", async () => {
  const h = await harness();
  try {
    await h.config("original");
    await h.start();
    await h.config("changed");
    await h.emit("session_shutdown", { reason: "reload" });
    await h.emit("session_start", { reason: "resume" });
    assert.match(h.statuses.at(-1)!, /original/);
    await h.emit("session_shutdown", { reason: "new" });
    h.newSession();
    await h.emit("session_start", { reason: "new" });
    assert.match(h.statuses.at(-1)!, /changed/);
  } finally {
    await h.close();
  }
});

test("child processes inherit project and restore parent credentials", async () => {
  const parent = JSON.stringify({
    url: "BACKEND_URL",
    projectName: "parent-project",
    scope: {
      recording: {
        run_id: "parent-run",
        recording_id: "parent-recording",
        run_write_token: "parent-secret",
        project_id: "parent-project-id",
      },
      turnId: "parent-turn",
    },
  });
  const h = await harness(parent);
  const inherited = process.env.SOVARA_PI_PARENT;
  try {
    await h.config("workspace");
    await h.start();
    assert.match(h.statuses.at(-1)!, /parent-project/);
    await h.prompt();
    const subrun = h.backend.calls.find((c) => c.path === "/runner/subrun")!;
    assert.equal(subrun.body.parent_run_id, "parent-run");
    assert.equal(subrun.body.turn_id, "parent-turn");
    assert.equal(subrun.headers["x-sovara-run-token"], "parent-secret");
    assert.equal(
      JSON.parse(process.env.SOVARA_PI_PARENT!).projectName,
      "parent-project",
    );
    await h.emit("agent_settled");
    assert.equal(process.env.SOVARA_PI_PARENT, inherited);
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/register").length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("retrieval failure leaves context intact; export failure never reports success", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    h.backend.reject("/internal/lessons/retrieve");
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "task", timestamp: 1 },
    ];
    const result = await h.emit("context_with_system", { messages });
    assert.deepEqual(result.messages, messages);
    h.backend.reject("");
    await h.emit("before_provider_request", { payload: { model: "test" } });
    h.backend.reject("/internal/runner/llm/finalize");
    await h.emit("message_end", {
      message: { role: "assistant", content: "answer", stopReason: "stop" },
    });
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "sovara: export incomplete");
  } finally {
    await h.close();
  }
});

test("compaction produces one summary observation without a dangling model step", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    await h.emit("session_before_compact");
    await h.emit("before_provider_request", {
      payload: { messages: ["summary input"] },
    });
    await h.emit("session_compact", {
      compactionEntry: { summary: "summary", usage: { input: 3, output: 2 } },
    });
    await h.emit("agent_settled");
    const preparations = h.backend.calls.filter((c) =>
      c.path.endsWith("/prepare"),
    );
    assert.equal(preparations.length, 1);
    assert.equal(preparations[0].body.api_type, "pi.summary");
    assert.deepEqual(
      JSON.parse(preparations[0].body.input_json).raw.provider_payload,
      { messages: ["summary input"] },
    );
    assert.equal(
      h.backend.calls.filter((c) => c.path.endsWith("/finalize")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("successful lessons are injected while trace failure remains visible", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    h.backend.reject("/internal/runner/llm/finalize");
    const result = await h.emit("context_with_system", {
      messages: [{ role: "user", content: "task", timestamp: 1 }],
    });
    assert.match(JSON.stringify(result.messages), /Use a deterministic clock/);
    h.backend.reject("");
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "sovara: export incomplete");
  } finally {
    await h.close();
  }
});

for (const event of ["before_provider_request", "tool_execution_start"]) {
  test(`Pi cancellation interrupts ${event}`, { timeout: 3000 }, async () => {
    const h = await harness();
    try {
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      await h.start();
      await h.prompt();
      const reached = h.backend.blockNext("/internal/runner/llm/prepare");
      const running = h.emit(event, {
        payload: {},
        toolCallId: "a",
        toolName: "read",
        args: {},
      });
      await reached;
      controller.abort();
      await running;
      const before = h.backend.calls.length;
      await h.emit(event, {
        payload: {},
        toolCallId: "b",
        toolName: "read",
        args: {},
      });
      assert.equal(
        h.backend.calls.length,
        before,
        "already cancelled hooks must send no requests",
      );
    } finally {
      await h.close();
    }
  });
}

test("failed standalone summary closes its turn and resets capture before normal retrieval", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.emit("session_before_compact", { signal: AbortSignal.abort() });
    await h.emit("before_provider_request", {
      payload: { messages: ["summary input"] },
    });
    await h.emit("session_compact_failed", { aborted: true });
    const summary = h.backend.calls.find((call) =>
      call.path.endsWith("/finalize"),
    )!;
    assert.equal(summary.body.api_type, "pi.summary");
    assert.equal(summary.body.status, "error");
    assert.equal(h.backend.calls.at(-1)!.path, "/runner/deregister");
    await h.prompt();
    const result = await h.emit("context_with_system", {
      messages: [{ role: "user", content: "task", timestamp: 1 }],
    });
    assert.match(JSON.stringify(result.messages), /Use a deterministic clock/);
    assert.equal(
      h.backend.calls.filter((call) => call.path.endsWith("/retrieve")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("skipped lesson retrieval preserves its warning in traces and Pi without repeated alerts", async () => {
  const h = await harness();
  const warning = "Lesson injection skipped. Missing: Fast Helper Model.";
  try {
    h.backend.retrieval({
      lessons: [],
      rendered_lessons_block: "",
      retrieval_status: "complete",
      warning_message: warning,
    });
    await h.start();
    await h.prompt();
    const messages = [{ role: "user", content: "Add Micron?", timestamp: 1 }];
    for (let i = 0; i < 2; i++) {
      const result = await h.emit("context_with_system", { messages });
      assert.deepEqual(result.messages, messages);
    }
    assert.deepEqual(h.notifications, [`Sovara: ${warning}`]);
    const retrieval = h.backend.calls.find((c) =>
      c.path.endsWith("/finalize"),
    )!;
    assert.equal(
      JSON.parse(retrieval.body.output_json).raw.tool_output.warning_message,
      warning,
    );
    await h.emit("agent_settled");
    assert.match(h.statuses.at(-1)!, /lesson retrieval warning/);
    await h.command("sovara");
    assert.match(h.notifications.at(-1)!, /Lessons: .*Fast Helper Model/);

    h.backend.retrieval({
      lessons: [],
      rendered_lessons_block: "",
      retrieval_status: "complete",
    });
    await h.prompt();
    await h.emit("context_with_system", { messages });
    await h.emit("agent_settled");
    assert.equal(h.statuses.at(-1), "sovara: turn export acknowledged");
    await h.command("sovara");
    assert.doesNotMatch(h.notifications.at(-1)!, /Fast Helper Model/);
  } finally {
    await h.close();
  }
});

test("a failed retrieval response is recorded as failure while Pi continues", async () => {
  const h = await harness();
  try {
    h.backend.retrieval({
      lessons: [],
      rendered_lessons_block: "",
      retrieval_status: "failed",
      error_message: "retrieval_unavailable",
    });
    await h.start();
    await h.prompt();
    const messages = [{ role: "user", content: "task", timestamp: 1 }];
    assert.deepEqual(
      (await h.emit("context_with_system", { messages })).messages,
      messages,
    );
    assert.deepEqual(h.notifications, ["Sovara: retrieval_unavailable"]);
    const retrieval = h.backend.calls.find((c) =>
      c.path.endsWith("/finalize"),
    )!;
    assert.equal(retrieval.body.status, "error");
    await h.emit("agent_settled");
    assert.match(h.statuses.at(-1)!, /lesson retrieval warning/);
  } finally {
    await h.close();
  }
});
