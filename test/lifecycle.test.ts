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
  // A normal user-managed MCP connection must not conflict with the plugin.
  await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { sovara: { url: "https://example.invalid/mcp" } },
  }));
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
  const commands = new Map<string, any>();
  let entries: any[] = [];
  let sessionId = "session-1";
  const statuses: string[] = [];
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
    signal: undefined,
    model: { id: "test", provider: "test" },
    ui: {
      setStatus: (_key: string, value: string) => statuses.push(value),
      notify() {},
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
    emit,
    commands,
    ctx,
    async config(lessonMode: string) {
      await writeFile(
        join(cwd, ".pi", "sovara.json"),
        JSON.stringify({ projectName: "workspace", lessonMode }),
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

test("mode change applies to new sessions while resume keeps its assignment", async () => {
  const h = await harness();
  try {
    await h.start();
    await h.commands.get("sovara").handler("mode mcp-system", h.ctx);
    await h.emit("session_shutdown", { reason: "reload" });
    await h.emit("session_start", { reason: "resume" });
    assert.match(h.statuses.at(-1)!, /automatic/);
    await h.emit("session_shutdown", { reason: "new" });
    h.newSession();
    await h.emit("session_start", { reason: "new" });
    assert.match(h.statuses.at(-1)!, /mcp-system/);
  } finally {
    await h.close();
  }
});

test("child processes inherit project and experiment mode and restore parent credentials", async () => {
  const parent = JSON.stringify({
    url: "BACKEND_URL",
    projectName: "parent-project",
    lessonMode: "mcp-system",
    sessionId: "parent-session",
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
    await h.config("automatic");
    await h.start();
    assert.match(h.statuses.at(-1)!, /parent-project.*mcp-system/);
    await h.prompt();
    const subrun = h.backend.calls.find((c) => c.path === "/runner/subrun")!;
    assert.equal(subrun.body.parent_run_id, "parent-run");
    assert.equal(subrun.body.turn_id, "parent-turn");
    assert.equal(subrun.headers["x-sovara-run-token"], "parent-secret");
    assert.equal(
      JSON.parse(process.env.SOVARA_PI_PARENT!).lessonMode,
      "mcp-system",
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
