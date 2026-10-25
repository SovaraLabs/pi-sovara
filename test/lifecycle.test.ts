import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { createClient } from "../src/recorder.ts";
import { fixtureServer } from "./helpers.ts";

async function harness(child = false) {
  const backend = await fixtureServer(),
    cwd = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  await mkdir(join(cwd, ".pi"));
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
  };
  process.env.SOVARA_EXEC_SERVER_URL = backend.url;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  delete process.env.SOVARA_PI_PARENT;
  const parent = child
    ? await createClient(backend.config).startRecording("parent", {
        captureLogs: false,
      })
    : undefined;
  const originalParent = parent
    ? JSON.stringify(parent.exportParentContext())
    : undefined;
  if (originalParent) process.env.SOVARA_PI_PARENT = originalParent;
  const handlers = new Map<string, (event: any, ctx: any) => any>(),
    commands = new Map<string, any>();
  let entries: any[] = [],
    sessionId = "session-1";
  const notifications: string[] = [],
    statuses: string[] = [];
  const api = {
    on: (name: string, callback: any) => handlers.set(name, callback),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => false,
    signal: new AbortController().signal as AbortSignal | undefined,
    model: undefined,
    modelRegistry: { getAll: () => [] },
    ui: {
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify: (value: string) => notifications.push(value),
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getHeader: () => ({}),
    },
  };
  extension(api);
  const emit = (name: string, event: any = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return {
    backend,
    cwd,
    ctx,
    notifications,
    statuses,
    parent,
    originalParent,
    entries: () => entries,
    emit,
    config: (projectName: string) =>
      writeFile(join(cwd, ".pi/sovara.json"), JSON.stringify({ projectName })),
    newSession() {
      sessionId = "session-2";
      entries = [];
    },
    start: () => emit("session_start", { reason: "startup" }),
    prompt: () =>
      emit("before_agent_start", {
        messageType: "user",
        prompt: "controlled task",
      }),
    command: () => commands.get("sovara").handler("", ctx),
    async close() {
      await emit("session_shutdown", { reason: "quit" });
      await parent?.finish();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await backend.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("project resume/new-session binding and native context immutability", async () => {
  const h = await harness();
  try {
    await h.config("first");
    await h.start();
    await h.prompt();
    const messages = [{ role: "user", content: "unchanged" }];
    assert.equal(await h.emit("context_with_system", { messages }), undefined);
    assert.deepEqual(messages, [{ role: "user", content: "unchanged" }]);
    await h.emit("agent_settled", { aborted: false });
    await h.config("second");
    await h.emit("session_start", { reason: "resume" });
    await h.prompt();
    await h.emit("agent_settled", { aborted: false });
    h.newSession();
    await h.emit("session_start", { reason: "new" });
    await h.prompt();
    await h.emit("agent_settled", { aborted: false });
    assert.deepEqual(
      h.backend.calls
        .filter((c) => c.path === "/runner/register")
        .map((c) => c.body.project_name),
      ["first", "first", "second"],
    );
  } finally {
    await h.close();
  }
});

test("child handoff preserves durable trace through turns and stores no credentials", async () => {
  const h = await harness(true);
  try {
    await h.start();
    await h.prompt();
    const first = h
      .entries()
      .find((entry) => entry.customType === "sovara-child-v1")!.data;
    assert.notEqual(first.traceId, h.parent!.traceId);
    assert.equal(process.env.SOVARA_PI_PARENT, h.originalParent);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(process.env.SOVARA_PI_PARENT, h.originalParent);
    await h.prompt();
    const second = h.backend.calls.find(
      (c) => c.path === "/runner/subtrace/attach",
    )!.body;
    assert.equal(second.trace_id, first.traceId);
    assert.equal(process.env.SOVARA_PI_PARENT, h.originalParent);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/subtrace").length,
      1,
    );
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/subtrace/attach")
        .length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(h.entries()),
      /traceWriteToken|CONTROLLED_TOKEN/,
    );
    assert.equal(h.parent!.state, "active");
  } finally {
    await h.close();
  }
});

test("tools and MCP have one owner, preserve returned errors, and cancel missing ends", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    await h.emit("tool_execution_start", {
      toolCallId: "a",
      toolName: "mcp__fixture__lookup",
      args: { q: 1 },
      parentToolCallId: "parent-tool",
    });
    await h.emit("tool_execution_end", {
      toolCallId: "a",
      result: { isError: true, text: "controlled failure" },
      isError: true,
    });
    await h.emit("tool_execution_start", {
      toolCallId: "b",
      toolName: "read",
      args: { path: "file" },
    });
    await h.emit("agent_settled", { aborted: true });
    const prepares = h.backend.calls.filter((c) => c.path.endsWith("/prepare")),
      finals = h.backend.calls.filter((c) => c.path.endsWith("/finalize"));
    assert.equal(prepares.length, 2);
    assert.equal(finals.length, 2);
    assert.equal(prepares[0].body.api_type, "sovara.trace");
    assert.equal(prepares[0].body.step_kind, "mcp");
    assert.match(prepares[0].body.input_json, /parent-tool/);
    assert.match(finals[0].body.output_json, /controlled failure/);
    assert.equal(finals[0].body.status, "error");
    assert.match(finals[1].body.error_json, /AbortError/);
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("SDK preparation/export failure leaves Pi running and diagnostics safe", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    h.backend.reject("/internal/runner/llm/prepare");
    await h.emit("tool_execution_start", {
      toolCallId: "failed",
      toolName: "read",
      args: {},
    });
    await h.emit("agent_settled", { aborted: false });
    await h.command();
    assert(h.notifications.length > 0);
    assert.doesNotMatch(h.notifications.join(), /PRIVATE ERROR PAYLOAD/);
    assert(h.statuses.some((s) => s.includes("incomplete")));
  } finally {
    await h.close();
  }
});

test("summary has an independent turn on an active recording and never fabricates a model step", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.prompt();
    const signal = new AbortController().signal;
    await h.emit("session_before_compact", { signal });
    await h.emit("session_compact", {
      compactionEntry: { summary: "from another extension" },
    });
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/register").length,
      1,
    );
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/turns").length,
      2,
    );
    assert.equal(
      h.backend.calls.filter((c) => c.path.endsWith("/prepare")).length,
      0,
    );
    await h.emit("agent_settled", { aborted: false });
    assert.equal(
      h.backend.calls.filter((c) => c.path === "/runner/deregister").length,
      1,
    );
  } finally {
    await h.close();
  }
});
