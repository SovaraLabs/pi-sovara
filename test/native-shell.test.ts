import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import {
  AgentSession,
  createAgentSession,
  createBashTool,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SovaraClient } from "@sovara/sdk";
import { fixtureServer, completion } from "./helpers.ts";

// A caller may have acquired the public getter before the extension was loaded.
const capturedGetDefinition = AgentSession.prototype.getToolDefinition;

async function harness() {
  const server = await fixtureServer(),
    directory = await mkdtemp(join(tmpdir(), "pi-native-shell-"));
  const previous = Object.fromEntries(
    ["SOVARA_EXEC_SERVER_URL", "SOVARA_PI_PARENT", "PI_CODING_AGENT_DIR"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.SOVARA_EXEC_SERVER_URL = server.url;
  delete process.env.SOVARA_PI_PARENT;
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("fixture", {
    api: "openai-completions",
    apiKey: "CONTROLLED",
    baseUrl: server.url + "/v1",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      },
    ],
  });
  const sessions: AgentSession[] = [],
    commands = new Map<string, string>(),
    timeouts = new Map<string, number>();
  const held = new Map<string, () => void>();
  let hold = false;
  server.provider((body, response) => {
    const last = body.messages.findLastIndex((m: any) => m.role === "user");
    const text = JSON.stringify(body.messages[last]);
    const id = [...commands.keys()].find((id) => text.includes(`SHELL_${id}`))!;
    if (body.messages.slice(last).some((m: any) => m.role === "tool"))
      return completion(response, "Done");
    const release = () => {
      if (!response.writableEnded)
        completion(response, "", {
          name: "bash",
          arguments: {
            command: commands.get(id)!,
            ...(timeouts.has(id) ? { timeout: timeouts.get(id) } : {}),
          },
        });
    };
    if (hold) held.set(id, release);
    else release();
  });
  return {
    server,
    directory,
    commands,
    timeouts,
    held,
    hold(value: boolean) {
      hold = value;
    },
    async session(id: string, mode?: "custom" | "base" | "late") {
      const cwd = join(directory, id),
        agentDir = join(cwd, "agent");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi/sovara.json"),
        JSON.stringify({ projectName: `shell-${id}` }),
      );
      const child = join(cwd, "child.mjs");
      await writeFile(
        child,
        `const p=JSON.parse(process.env.SOVARA_PI_PARENT||'null');console.log(JSON.stringify({parent:p&&{traceId:p.traceId,projectName:p.projectName,turnId:p.turnId,hasToken:!!p.traceWriteToken},marker:process.env.SHELL_MARKER,cwd:process.cwd(),path:process.env.PATH}));`,
      );
      commands.set(id, `'${process.execPath}' '${child}'`);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const settings = SettingsManager.inMemory({
        defaultProjectTrust: "always",
        compaction: { enabled: false },
        cacheWarming: "off",
        retry: { enabled: false },
        shellPath: "/bin/bash",
        shellCommandPrefix: "export SHELL_MARKER=first",
      });
      let api!: ExtensionAPI;
      const results: any[] = [];
      let customCalls = 0;
      const custom: ToolDefinition = {
        name: "bash",
        label: "Custom",
        description: "Caller bash",
        parameters: Type.Object({ command: Type.String() }),
        execute: async () => {
          customCalls++;
          return {
            content: [{ type: "text", text: "caller result" }],
            details: {},
          };
        },
      };
      const extensionPath = resolve(
        process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".",
        "src/index.ts",
      );
      const lateLoader = join(cwd, "late-loader.ts");
      // Pi supplies its bundled-peer aliases; defer only invoking the extension
      // factory until this public command runs in the already-existing session.
      await writeFile(
        lateLoader,
        `import sovara from ${JSON.stringify(extensionPath)};
export default function(pi) { pi.registerCommand("controlled-load-sovara", {
  description: "Controlled delayed extension initialization", handler: async () => sovara(pi),
}); }`,
      );
      const extensionPaths = [
        lateLoader,
        ...(mode === "late" ? [] : [extensionPath]),
      ];
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        extensionFactories: [
          (pi) => {
            api = pi;
            if (mode === "custom") pi.registerTool(custom);
            pi.on("tool_execution_end", (event) => {
              results.push(event.result);
            });
          },
        ],
        additionalExtensionPaths: extensionPaths,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      let { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "fixture")!,
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash"],
      });
      if (mode === "base") {
        const agent = session.agent,
          sessionManager = session.sessionManager;
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
        await loader.reload();
        const base = createBashTool(cwd, {
          operations: {
            exec: async (_command, _cwd, { onData }) => {
              customCalls++;
              onData(Buffer.from("caller base result"));
              return { exitCode: 0 };
            },
          },
        });
        session = new AgentSession({
          agent,
          sessionManager,
          settingsManager: settings,
          cwd,
          resourceLoader: loader,
          modelRuntime: runtime,
          baseToolsOverride: { bash: base },
          initialActiveToolNames: ["bash"],
        });
      }
      sessions.push(session);
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          throw error;
        },
      });
      return {
        session,
        settings,
        results,
        api,
        custom,
        cwd,
        customCalls: () => customCalls,
        async unload() {
          extensionPaths.length = 1;
          await session.reload();
        },
        async loadLate() {
          await session.prompt("/controlled-load-sovara");
          await session.bindExtensions({ mode: "print" });
        },
        parent: () =>
          JSON.parse(
            results
              .at(-1)
              .content.filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(""),
          ),
        prompt: () =>
          session.prompt(`SHELL_${id}: execute the supplied shell command`),
      };
    },
    async close() {
      for (const session of sessions) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const inherited of [false, true])
  test(`native bash preserves startup environment, settings, definition and reload (incoming parent: ${inherited})`, async () => {
    const h = await harness();
    let ancestor;
    try {
      if (inherited) {
        const client = new SovaraClient({
          url: h.server.url,
          projectName: "shell-A",
          autoInstrumentation: { providerHttp: false, mcp: false },
        });
        ancestor = await client.startRecording("ancestor", {
          captureLogs: false,
        });
        const turn = await ancestor.startTurn();
        process.env.SOVARA_PI_PARENT = JSON.stringify(
          turn.exportParentContext(),
        );
      }
      const startup = process.env.SOVARA_PI_PARENT,
        a = await h.session("A");
      const original = a.session.getToolDefinition("bash")!,
        fields = { ...original },
        execute = original.execute;
      await a.prompt();
      const expectedParent = startup ? JSON.parse(startup) : undefined;
      const checkParent = (value: any) => assert.deepEqual(value, expectedParent ? {
        traceId: expectedParent.traceId,
        projectName: expectedParent.projectName,
        turnId: expectedParent.turnId,
        hasToken: true,
      } : null);
      const first = a.parent();
      checkParent(first.parent);
      assert.equal(first.marker, "first");
      assert.equal(first.cwd, await realpath(a.cwd));
      assert.ok(first.path);
      assert.equal(process.env.SOVARA_PI_PARENT, startup);
      assert.equal(a.session.getToolDefinition("bash"), original);
      assert.equal(original.execute, execute);
      assert.deepEqual(original, fields, "All native definition fields stay caller-owned");
      a.settings.setShellCommandPrefix("export SHELL_MARKER=changed");
      const shellPath = join(a.cwd, "controlled-shell"),
        shellMarker = join(a.cwd, "shell-selected");
      await writeFile(
        shellPath,
        `#!/bin/sh\nprintf selected > '${shellMarker}'\nexec /bin/sh "$@"\n`,
      );
      await chmod(shellPath, 0o755);
      a.settings.setShellPath(shellPath);
      await a.prompt();
      assert.equal(
        a.parent().marker,
        "first",
        "Native factories retain their settings until reload",
      );
      await assert.rejects(readFile(shellMarker, "utf8"), { code: "ENOENT" });
      checkParent(a.parent().parent);
      await a.session.reload();
      assert.equal(
        original.execute,
        execute,
        "reload releases old definition ownership",
      );
      await a.prompt();
      assert.equal(await readFile(shellMarker, "utf8"), "selected");
      assert.equal(a.parent().marker, "changed");
      checkParent(a.parent().parent);
      assert.equal(process.env.SOVARA_PI_PARENT, startup);
      const current = a.session.getToolDefinition("bash")!;
      const newer = async () => ({ content: [] as any[], details: {} });
      current.execute = newer;
      await a.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      assert.equal(
        current.execute,
        newer,
        "disposal must not overwrite a later wrapper",
      );
    } finally {
      await ancestor?.finish();
      await h.close();
    }
  });

test("a session rebuilt while unloaded cannot authorize unseen factory closures on reload", async () => {
  const h = await harness();
  try {
    const a = await h.session("A");
    await a.prompt();
    await a.unload();
    const definition = capturedGetDefinition.call(a.session, "bash")!;
    let calls = 0;
    const replacement = createBashToolDefinition(a.cwd, {
      operations: {
        exec: async (_command, _cwd, { onData }) => {
          calls++;
          onData(Buffer.from("unloaded caller execution"));
          return { exitCode: 0 };
        },
      },
    }).execute;
    definition.execute = replacement;
    await a.loadLate();
    await a.prompt();
    assert.equal(calls, 1);
    assert.equal(definition.execute, replacement);
  } finally {
    await h.close();
  }
});

test("extension never wraps public methods, property descriptors or caller getters", async () => {
  const h = await harness();
  const prototype = AgentSession.prototype;
  const active = Object.getOwnPropertyDescriptor(
    prototype,
    "getActiveToolNames",
  )!;
  const definition = Object.getOwnPropertyDescriptor(
    prototype,
    "getToolDefinition",
  )!;
  const receivers: AgentSession[] = [];
  const earlier = function (this: AgentSession, ...args: unknown[]) {
    receivers.push(this);
    return Reflect.apply(active.value, this, args);
  };
  Object.defineProperty(prototype, "getActiveToolNames", {
    ...active,
    value: earlier,
  });
  try {
    const a = await h.session("A"),
      b = await h.session("B");
    a.session.getActiveToolNames();
    b.session.getActiveToolNames();
    for (const [name, original] of [
      ["getActiveToolNames", active],
      ["getToolDefinition", definition],
    ] as const) {
      const current = Object.getOwnPropertyDescriptor(prototype, name)!;
      assert.deepEqual({ ...current, value: original.value }, original);
    }
    const state = a.session.agent.state;
    const descriptor = Object.getOwnPropertyDescriptor(state, "tools")!;
    let setterReceiver: unknown;
    const laterSetter = function (this: unknown, value: unknown) {
      setterReceiver = this;
      Reflect.apply(descriptor.set!, this, [value]);
    };
    Object.defineProperty(state, "tools", { ...descriptor, set: laterSetter });
    const tools = state.tools;
    state.tools = tools;
    assert.equal(setterReceiver, state);
    assert.notEqual(
      state.tools,
      tools,
      "Native setter still copies the caller array",
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(state, "tools")!.get,
      descriptor.get,
    );
    await a.prompt();
    await a.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    await b.prompt();
    assert.equal(b.parent().parent, null);
    assert.equal(
      Object.getOwnPropertyDescriptor(state, "tools")!.set,
      laterSetter,
    );
    assert.ok(receivers.includes(a.session) && receivers.includes(b.session));
    const wrappedGetter = prototype.getToolDefinition;
    let getterReceiver: unknown;
    const laterGetter: typeof wrappedGetter = function (
      this: AgentSession,
      name,
    ) {
      getterReceiver = this;
      return Reflect.apply(wrappedGetter, this, [name]);
    };
    prototype.getToolDefinition = laterGetter;
    await h.close();
    assert.equal(prototype.getActiveToolNames, earlier);
    assert.equal(prototype.getToolDefinition, laterGetter);
    assert.equal(laterGetter.call(b.session, "bash")?.name, "bash");
    assert.equal(getterReceiver, b.session);
  } finally {
    await h.close();
    Object.defineProperty(prototype, "getActiveToolNames", active);
    Object.defineProperty(prototype, "getToolDefinition", definition);
  }
});

test("overlapping native bash sessions receive no extension-generated parent in either completion order", async () => {
  const h = await harness();
  try {
    const a = await h.session("A"),
      b = await h.session("B");
    h.hold(true);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      h.held.clear();
      const work = new Map([
        [a, a.prompt()],
        [b, b.prompt()],
      ]);
      for (let n = 0; h.held.size !== 2 && n < 200; n++) await delay(5);
      assert.equal(h.held.size, 2);
      for (const item of order) {
        h.held.get(item === a ? "A" : "B")!();
        await work.get(item);
      }
      for (const item of [a, b]) assert.equal(item.parent().parent, null);
      assert.equal(process.env.SOVARA_PI_PARENT, undefined);
    }
  } finally {
    await h.close();
  }
});

for (const mode of ["custom", "base"] as const)
  test(`caller ${mode} bash remains authoritative, including SDK base overrides`, async () => {
    const h = await harness();
    try {
      const a = await h.session("A", mode),
        definition = a.session.getToolDefinition("bash")!,
        execute = definition.execute;
      await a.prompt();
      assert.equal(a.customCalls(), 1);
      assert.equal(a.session.getToolDefinition("bash"), definition);
      assert.equal(definition.execute, execute);
      await a.session.reload();
      await a.prompt();
      assert.equal(a.customCalls(), 2);
      assert.equal(definition.execute, execute);
      assert.equal(
        h.server.calls.filter(
          (c) => c.path.endsWith("/finalize") && c.body.step_kind === "tool",
        ).length,
        2,
      );
    } finally {
      await h.close();
    }
  });

test("late and dynamic custom bash registration supersedes native ownership without changing custom identity", async () => {
  const h = await harness();
  try {
    const a = await h.session("A");
    await a.prompt();
    a.api.registerTool(a.custom);
    const execute = a.custom.execute;
    await a.prompt();
    assert.equal(a.customCalls(), 1);
    assert.equal(a.session.getToolDefinition("bash"), a.custom);
    assert.equal(a.custom.execute, execute);
    const replacement = {
      ...a.custom,
      execute: async () => ({
        content: [{ type: "text" as const, text: "dynamic replacement" }],
        details: {},
      }),
    };
    a.api.registerTool(replacement);
    await a.prompt();
    assert.equal(a.session.getToolDefinition("bash"), replacement);
    assert.equal(a.results.at(-1).content[0].text, "dynamic replacement");
    await a.session.reload();
    await a.prompt();
    assert.equal(a.parent().parent, null);
  } finally {
    await h.close();
  }
});

test("native bash retains truncation, nonzero errors, timeout and cancellation", async () => {
  const h = await harness();
  try {
    const a = await h.session("A");
    h.commands.set(
      "A",
      `'${process.execPath}' -e 'console.log("x".repeat(60000))'`,
    );
    await a.prompt();
    assert.ok(a.results.at(-1).details.truncation);
    const full = a.results.at(-1).details.fullOutputPath;
    assert.ok((await readFile(full, "utf8")).length > 60000);
    await rm(full, { force: true });
    h.commands.set("A", "printf controlled-failure; exit 7");
    await a.prompt();
    assert.equal(a.results.at(-1).isError, true);
    assert.match(a.results.at(-1).content[0].text, /code 7/);
    h.commands.set("A", "sleep 30");
    h.timeouts.set("A", 0.02);
    await a.prompt();
    assert.match(JSON.stringify(a.results.at(-1)), /timed out/i);
    h.timeouts.delete("A");
    const marker = join(a.cwd, "started");
    h.commands.set("A", `printf started > '${marker}'; sleep 30`);
    const pending = a.prompt();
    let started = false;
    for (let n = 0; n < 200; n++) {
      try {
        await readFile(marker);
        started = true;
        break;
      } catch {
        await delay(5);
      }
    }
    assert.ok(started);
    await a.session.abort();
    await pending;
    assert.match(JSON.stringify(a.results.at(-1)), /aborted/i);
    assert.equal(
      h.server.calls.filter(
        (c) => c.path.endsWith("/finalize") && c.body.step_kind === "tool",
      ).length,
      4,
    );
  } finally {
    await h.close();
  }
});

test("a pre-existing native execute wrapper remains caller-owned", async () => {
  const h = await harness();
  try {
    const a = await h.session("A"),
      definition = a.session.getToolDefinition("bash")!;
    const original = definition.execute;
    let calls = 0;
    const wrapped: typeof original = async (...args) => {
      calls++;
      return original(...args);
    };
    definition.execute = wrapped;
    await a.prompt();
    assert.equal(calls, 1);
    assert.equal(definition.execute, wrapped);
    // This is now custom execution: the caller owns its explicit native env.
    assert.equal(a.parent().parent, null);
    await a.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    assert.equal(definition.execute, wrapped);
  } finally {
    await h.close();
  }
});

for (const exposure of [
  "definition",
  "captured-getter",
  "lists",
  "state-tools",
] as const)
  test(`public ${exposure} exposure cannot bless a customized native factory executor`, async () => {
    const h = await harness();
    try {
      const a = await h.session("A");
      // Lists expose metadata, while state.tools exposes the callable wrapper.
      if (exposure === "lists") {
        assert.ok(a.session.getAllTools().some((tool) => tool.name === "bash"));
        assert.ok(a.session.getActiveToolNames().includes("bash"));
        assert.ok(a.session.getCallableToolNames().includes("bash"));
        assert.ok(a.api.getAllTools().some((tool) => tool.name === "bash"));
        assert.ok(a.api.getActiveTools().includes("bash"));
      }
      const definition =
        exposure === "definition"
          ? a.session.getToolDefinition("bash")!
          : capturedGetDefinition.call(a.session, "bash")!;
      const target =
        exposure === "state-tools"
          ? a.session.agent.state.tools.find((tool) => tool.name === "bash")!
          : definition;
      let customCalls = 0;
      const options = {
        operations: {
          exec: async (
            _command: string,
            _cwd: string,
            { onData }: { onData: (chunk: Buffer) => void },
          ) => {
            customCalls++;
            onData(Buffer.from("caller native factory execution"));
            return { exitCode: 0 };
          },
        },
      };
      const replacement =
        exposure === "state-tools"
          ? createBashTool(a.cwd, options).execute
          : createBashToolDefinition(a.cwd, options).execute;
      target.execute = replacement as typeof target.execute;
      await a.prompt();
      assert.equal(customCalls, 1);
      assert.equal(target.execute, replacement);
      assert.equal(
        a.results.at(-1).content[0].text,
        "caller native factory execution",
      );
      await a.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      assert.equal(target.execute, replacement);
    } finally {
      await h.close();
    }
  });

test("caller native spawnHook and captured options stay unchanged", async () => {
  const h = await harness();
  try {
    const a = await h.session("A"),
      definition = capturedGetDefinition.call(a.session, "bash")!;
    let calls = 0;
    const replacement = createBashToolDefinition(a.cwd, {
      commandPrefix: "export SHELL_MARKER=caller-prefix",
      spawnHook: (context) => {
        calls++;
        return {
          ...context,
          env: { ...context.env, SOVARA_PI_PARENT: "null" },
        };
      },
    }).execute;
    definition.execute = replacement;
    await a.prompt();
    assert.equal(calls, 1);
    assert.equal(definition.execute, replacement);
    assert.equal(a.parent().parent, null);
    assert.equal(a.parent().marker, "caller-prefix");
  } finally {
    await h.close();
  }
});

for (const customized of [false, true])
  test(`late extension loading leaves existing native execution untouched (customized: ${customized})`, async () => {
    const h = await harness();
    try {
      const a = await h.session("A", "late"),
        definition = capturedGetDefinition.call(a.session, "bash")!;
      let calls = 0;
      if (customized)
        definition.execute = createBashToolDefinition(a.cwd, {
          operations: {
            exec: async (_command, _cwd, { onData }) => {
              calls++;
              onData(Buffer.from("late caller execution"));
              return { exitCode: 0 };
            },
          },
        }).execute;
      const original = definition.execute;
      await a.loadLate();
      await a.prompt();
      assert.equal(definition.execute, original);
      assert.equal(calls, customized ? 1 : 0);
      if (!customized) assert.equal(a.parent().parent, null);
      assert.equal(
        h.server.calls.filter(
          (call) =>
            call.path.endsWith("/finalize") && call.body.step_kind === "tool",
        ).length,
        1,
      );
    } finally {
      await h.close();
    }
  });


test("an earlier public getter and caller spawnHook retain execute identity and explicit omission", async () => {
  const h = await harness();
  const original = AgentSession.prototype.getToolDefinition;
  const seen = new WeakSet<object>();
  let customCalls = 0;
  let replacement: ToolDefinition["execute"] | undefined;
  const earlier: typeof original = function (this: AgentSession, name) {
    const definition = Reflect.apply(original, this, [name]);
    if (name === "bash" && definition && !seen.has(definition)) {
      seen.add(definition);
      replacement = createBashToolDefinition(this.sessionManager.getCwd(), {
        spawnHook(request) {
          customCalls++;
          const env = { ...request.env };
          delete env.SOVARA_PI_PARENT;
          return { ...request, env };
        },
      }).execute;
      definition.execute = replacement;
    }
    return definition;
  };
  AgentSession.prototype.getToolDefinition = earlier;
  try {
    const a = await h.session("A");
    const definition = a.session.getToolDefinition("bash")!;
    await a.prompt();
    assert.equal(customCalls, 1);
    assert.equal(a.parent().parent, null);
    assert.equal(definition.execute, replacement);
    assert.equal(AgentSession.prototype.getToolDefinition, earlier);
  } finally {
    await h.close();
    AgentSession.prototype.getToolDefinition = original;
  }
});
