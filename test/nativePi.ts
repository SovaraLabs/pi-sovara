import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { fixtureServer } from "./helpers.ts";
export async function nativePi(
  overrides: Parameters<typeof SettingsManager.inMemory>[0] = {},
  configure?: (cwd: string) => Promise<void>,
) {
  const server = await fixtureServer(),
    cwd = await mkdtemp(join(tmpdir(), "pi-native-"));
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
  };
  process.env.SOVARA_EXEC_SERVER_URL = server.url;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  delete process.env.SOVARA_PI_PARENT;
  await mkdir(join(cwd, ".pi"));
  await writeFile(
    join(cwd, ".pi/sovara.json"),
    JSON.stringify({ projectName: "fixture" }),
  );
  await writeFile(join(cwd, "input.txt"), "Synthetic test evidence");
  await configure?.(cwd);
  const agentDir = join(cwd, "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("sovara-test", {
    api: "openai-completions",
    apiKey: "CONTROLLED_PROVIDER_KEY",
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
  const settings = SettingsManager.inMemory({
    defaultProjectTrust: "always",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    cacheWarming: "off",
    retry: { enabled: false },
    ...overrides,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    extensionFactories: [
      { name: "mcp", factory: createMcpExtension(), builtin: true },
    ],
    additionalExtensionPaths: [
      resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/index.ts"),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search"],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("sovara-test", "synthetic")!,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "mcp__*", "*_mcp_resource*"],
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error),
  });
  return {
    server,
    cwd,
    session,
    runtime,
    settings,
    errors,
    async close() {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
