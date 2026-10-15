import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { fixtureServer } from "./helpers.ts";
import { MODES } from "../src/config.ts";

for (const lessonMode of MODES) {
  test(`real Pi loader and agent loop: ${lessonMode}`, async () => {
    const server = await fixtureServer();
    const cwd = await mkdtemp(join(tmpdir(), "pi-agent-test-"));
    const previous = process.env.SOVARA_EXEC_SERVER_URL;
    const previousToken = process.env.SOVARA_AGENT_TOKEN;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.SOVARA_EXEC_SERVER_URL = server.config.execUrl;
    process.env.SOVARA_AGENT_TOKEN = "test-token";
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;
    try {
      await mkdir(join(cwd, ".pi"));
      await writeFile(
        join(cwd, ".pi", "sovara.json"),
        JSON.stringify({ projectName: "fixture", lessonMode }),
      );
      await writeFile(join(cwd, "input.txt"), "Synthetic test evidence");
      const agentDir = join(cwd, "agent");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-cache.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const inputs: unknown[] = [];
      let index = 0;
      modelRuntime.registerProvider("sovara-test", {
        api: "sovara-test-api",
        apiKey: "synthetic-key",
        baseUrl: "http://127.0.0.1:1",
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
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          void (async () => {
            try {
              inputs.push(structuredClone(context));
              await options?.onPayload?.(
                { model: model.id, messages: context.messages },
                model,
              );
              const current = index++;
              const call:
                | { name: string; arguments: Record<string, string> }
                | undefined =
                current === 0
                  ? { name: "read", arguments: { path: "input.txt" } }
                  : undefined;
              const message: AssistantMessage = {
                role: "assistant",
                api: "sovara-test-api",
                provider: "sovara-test",
                model: "synthetic",
                content: call
                  ? [{ type: "toolCall", id: `call-${current}`, ...call }]
                  : [
                      {
                        type: "text",
                        text: "Finished with deterministic tests.",
                      },
                    ],
                usage: {
                  input: 10,
                  output: 5,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 15,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: call ? "toolUse" : "stop",
                timestamp: Date.now(),
              };
              stream.push({ type: "start", partial: message });
              stream.push({
                type: "done",
                reason: message.stopReason as "stop" | "toolUse",
                message,
              });
              stream.end();
            } catch (error) {
              stream.end();
              throw error;
            }
          })();
          return stream;
        },
      });
      const settings = SettingsManager.inMemory({
        defaultProjectTrust: "always",
        compaction: { enabled: false },
        cacheWarming: "off",
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        additionalExtensionPaths: [resolve("src/index.ts")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search"],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const created = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: modelRuntime.getModel("sovara-test", "synthetic")!,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["read"],
      });
      session = created.session;
      const errors: unknown[] = [];
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          errors.push(error);
        },
      });
      await session.prompt("Inspect input.txt and explain how to test it.");
      assert.deepEqual(errors, []);
      assert.equal(inputs.length, 2);
      const retrievals = server.calls.filter(
        (c) => c.path === "/internal/lessons/retrieve",
      );
      assert.equal(retrievals.length, lessonMode === "automatic" ? 2 : 0);
      const finalized = server.calls.filter((c) =>
        c.path.endsWith("/finalize"),
      );
      assert.equal(
        finalized.filter((c) => c.body.step_kind === "llm").length,
        inputs.length,
      );
      assert.ok(finalized.some((c) => c.body.step_kind === "tool"));
      assert.ok(server.calls.some((c) => c.path === "/runner/deregister"));
      if (lessonMode === "automatic") {
        const secondQuery = JSON.parse(retrievals[1]!.body.raw_context);
        assert.deepEqual(secondQuery.prefix, []);
        assert.match(JSON.stringify(secondQuery.suffix), /Synthetic test evidence/);
        assert.doesNotMatch(JSON.stringify(secondQuery.suffix), /Inspect input.txt and explain/);
        assert.ok(
          inputs.every((input) =>
            JSON.stringify(input).includes("Use a deterministic clock."),
          ),
        );
      } else if (lessonMode === "mcp-reminder") {
        assert.match(
          JSON.stringify(inputs[0]),
          /Before proceeding with substantive work/,
        );
        assert.match(
          JSON.stringify(inputs[1]),
          /Before proceeding with substantive work/,
        );
      } else {
        assert.match(JSON.stringify(inputs[0]), /Use Sovara's retrieve tool/);
        assert.doesNotMatch(
          JSON.stringify(inputs),
          /Before proceeding with substantive work/,
        );
      }
    } finally {
      await session?.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session?.dispose();
      if (previous === undefined) delete process.env.SOVARA_EXEC_SERVER_URL;
      else process.env.SOVARA_EXEC_SERVER_URL = previous;
      if (previousToken === undefined) delete process.env.SOVARA_AGENT_TOKEN;
      else process.env.SOVARA_AGENT_TOKEN = previousToken;
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
