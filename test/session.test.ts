import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fixtureServer } from "./helpers.ts";

test("native session new, resume, and fork preserve project binding and restore provider ownership", async () => {
  const server = await fixtureServer(),
    cwd = await mkdtemp(join(tmpdir(), "pi-session-lifecycle-")),
    agentDir = join(cwd, "agent");
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
  };
  process.env.SOVARA_EXEC_SERVER_URL = server.url;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.SOVARA_PI_PARENT;
  let controller:
    | Awaited<ReturnType<typeof createAgentSessionRuntime>>
    | undefined;
  try {
    await mkdir(join(cwd, ".pi"));
    const configFile = join(cwd, ".pi/sovara.json");
    await writeFile(
      configFile,
      JSON.stringify({ projectName: "original-project" }),
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("fixture", {
      api: "openai-completions",
      apiKey: "CONTROLLED_KEY",
      baseUrl: server.url + "/v1",
      models: [
        {
          id: "synthetic",
          name: "Synthetic",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 4096,
        },
      ],
    });
    const original = modelRuntime.getRegisteredProviderConfig("fixture");
    const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({
          defaultProjectTrust: "always",
          compaction: { enabled: false },
          cacheWarming: "off",
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          additionalExtensionPaths: [
            resolve(
              process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".",
              "src/index.ts",
            ),
          ],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model: modelRuntime.getModel("fixture", "synthetic")!,
        tools: [],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    controller = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
    });
    const bind = async (session: AgentSession) => {
      await session.bindExtensions({ mode: "print" });
    };
    controller.setRebindSession(bind);
    await bind(controller.session);
    await controller.session.prompt("Original session task");
    const originalFile = controller.session.sessionManager.getSessionFile()!,
      originalId = controller.session.sessionManager.getSessionId();
    await writeFile(configFile, JSON.stringify({ projectName: "new-project" }));
    await controller.newSession();
    await controller.session.prompt("New session task");
    const newId = controller.session.sessionManager.getSessionId();
    assert.notEqual(newId, originalId);
    await controller.switchSession(originalFile);
    await controller.session.prompt("Resumed original task");
    assert.equal(controller.session.sessionManager.getSessionId(), originalId);
    const user = controller.session.sessionManager
      .getEntries()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!;
    await controller.fork(user.id, { position: "at" });
    await controller.session.prompt("Forked task");
    assert.notEqual(
      controller.session.sessionManager.getSessionId(),
      originalId,
    );
    assert.equal(
      controller.session.sessionManager.getHeader()?.parentSession,
      originalFile,
    );
    const registrations = server.calls.filter(
      (call) => call.path === "/runner/register",
    );
    assert.deepEqual(
      registrations.map((call) => call.body.project_name),
      ["original-project", "new-project", "original-project", "new-project"],
    );
    assert.equal(
      registrations[0]!.body.trace_id,
      registrations[2]!.body.trace_id,
    );
    assert.equal(
      server.calls.filter((call) => call.path.endsWith("/prepare")).length,
      4,
    );
    assert.equal(
      server.calls.filter((call) => call.path.endsWith("/finalize")).length,
      4,
    );
    assert.equal(
      server.calls.filter((call) => call.path === "/runner/deregister").length,
      4,
    );
    await controller.dispose();
    controller = undefined;
    assert.equal(
      modelRuntime.getRegisteredNativeProvider("fixture"),
      undefined,
    );
    assert.deepEqual(
      modelRuntime.getRegisteredProviderConfig("fixture"),
      original,
    );
  } finally {
    await controller?.dispose();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
