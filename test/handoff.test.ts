import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess, {
  execFile,
  exec as execShell,
  spawn,
  fork,
  spawnSync,
  execFileSync,
  execSync,
} from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fixtureServer, completion } from "./helpers.ts";

// Capture before loading the extension, as third-party launchers commonly do.
const exec = promisify(execFile);
const shell = promisify(execShell);
const capturedSpawn = spawn;
const capturedSync = spawnSync;
const originalPrompt = AgentSession.prototype.prompt;
const originalSpawn = (
  childProcess.ChildProcess.prototype as unknown as { spawn: unknown }
).spawn;
const readParent = "console.log(process.env.SOVARA_PI_PARENT || 'null')";
const args = ["--input-type=module", "-e", readParent];
async function spawnParent() {
  const child = capturedSpawn(process.execPath, args);
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("child failed")),
    );
  });
  return JSON.parse(text);
}

test("native overlapping sessions hand children their own turn and preserve subprocess semantics", async () => {
  const server = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), "pi-parent-concurrent-"));
  const previous = {
    SOVARA_EXEC_SERVER_URL: process.env.SOVARA_EXEC_SERVER_URL,
    SOVARA_PI_PARENT: process.env.SOVARA_PI_PARENT,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
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
    apiKey: "CONTROLLED_CANARY",
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
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] =
    [];
  const children: Record<string, any[]> = { A: [], B: [] };
  const late: Record<string, () => Promise<any>> = {};
  let releases: Record<string, () => void> = {};
  let entered: Record<string, () => void> = {};
  server.provider((body, response) => {
    const lastUser = body.messages.findLastIndex(
      (message: any) => message.role === "user",
    );
    const id = JSON.stringify(body.messages[lastUser]).includes("CONCURRENT_A")
      ? "A"
      : "B";
    if (
      body.messages
        .slice(lastUser)
        .some((message: any) => message.role === "tool")
    )
      return completion(response, "Done");
    releases[id] = () => {
      if (!response.writableEnded)
        completion(response, "", { name: "spawn_child", arguments: {} });
    };
    entered[id]();
  });
  try {
    for (const id of ["A", "B"]) {
      const cwd = join(directory, id),
        agentDir = join(cwd, "agent");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(cwd, ".pi/sovara.json"),
        JSON.stringify({ projectName: `project-${id}` }),
      );
      const childFile = join(cwd, "child.mjs");
      await writeFile(childFile, readParent);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const settings = SettingsManager.inMemory({
        defaultProjectTrust: "always",
        compaction: { enabled: false },
        cacheWarming: "off",
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        extensionFactories: [
          (pi) => {
            pi.registerTool({
              name: "spawn_child",
              label: "Spawn",
              description: "Controlled child",
              parameters: Type.Object({}),
              async execute() {
                assert.equal(process.env.SOVARA_PI_PARENT, undefined);
                const own = JSON.parse(
                  (await exec(process.execPath, args)).stdout,
                );
                const results = [
                  own,
                  JSON.parse(
                    (await shell(`'${process.execPath}' '${childFile}'`))
                      .stdout,
                  ),
                  await spawnParent(),
                  JSON.parse(
                    spawnSync(process.execPath, args, { encoding: "utf8" })
                      .stdout,
                  ),
                  JSON.parse(
                    execFileSync(process.execPath, args, { encoding: "utf8" }),
                  ),
                  JSON.parse(
                    execSync(`'${process.execPath}' '${childFile}'`, {
                      encoding: "utf8",
                    }),
                  ),
                ];
                const forked = fork(childFile, [], { silent: true });
                let output = "";
                forked.stdout!.on("data", (chunk) => {
                  output += chunk;
                });
                await new Promise<void>((resolve, reject) => {
                  forked.on("error", reject);
                  forked.on("close", (code) =>
                    code === 0 ? resolve() : reject(new Error("fork failed")),
                  );
                });
                results.push(JSON.parse(output));
                for (const result of results) assert.deepEqual(result, own);
                // Explicit env remains caller-owned, including deliberate handoff/opt-out.
                const env = { SOVARA_PI_PARENT: "CONTROLLED_EXPLICIT_VALUE" };
                assert.equal(
                  (
                    await exec(
                      process.execPath,
                      ["-e", "console.log(process.env.SOVARA_PI_PARENT)"],
                      { env },
                    )
                  ).stdout.trim(),
                  "CONTROLLED_EXPLICIT_VALUE",
                );
                assert.deepEqual(env, {
                  SOVARA_PI_PARENT: "CONTROLLED_EXPLICIT_VALUE",
                });
                assert.equal(
                  JSON.parse(
                    (await exec(process.execPath, args, { env: {} })).stdout,
                  ),
                  null,
                );
                assert.equal(
                  JSON.parse(
                    execFileSync(process.execPath, args, {
                      env: {},
                      encoding: "utf8",
                    }),
                  ),
                  null,
                );
                // An early saved sync function cannot be replaced through public Node APIs.
                assert.equal(
                  JSON.parse(
                    capturedSync(process.execPath, args, { encoding: "utf8" })
                      .stdout,
                  ),
                  null,
                );
                await assert.rejects(
                  exec("/sovara-controlled-nonexistent-command", []),
                  { code: "ENOENT" },
                );
                const abort = new AbortController();
                abort.abort();
                await assert.rejects(
                  exec(process.execPath, ["-e", "setTimeout(()=>{},1000)"], {
                    signal: abort.signal,
                  }),
                  { name: "AbortError" },
                );
                assert.throws(
                  () =>
                    spawnSync(process.execPath, [] as string[], 42 as never),
                  { code: "ERR_INVALID_ARG_TYPE" },
                );
                // Work created now but executed after this run must not borrow a later turn.
                let resume!: () => void;
                const gate = new Promise<void>((resolve) => {
                  resume = resolve;
                });
                const after = gate
                  .then(() => exec(process.execPath, args))
                  .then((result) => JSON.parse(result.stdout));
                late[id] = () => {
                  resume();
                  return after;
                };
                children[id].push(own);
                return {
                  content: [{ type: "text", text: "Child completed" }],
                  details: {},
                };
              },
            });
          },
        ],
        additionalExtensionPaths: [
          resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/index.ts"),
        ],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel("fixture", "fixture")!,
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["spawn_child"],
      });
      await session.bindExtensions({
        mode: "print",
        onError(error) {
          throw error;
        },
      });
      sessions.push(session);
    }
    let previousLate: Record<string, () => Promise<any>> = {};
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      releases = {};
      const gates = Object.fromEntries(
        ["A", "B"].map((id) => [
          id,
          new Promise<void>((resolve) => {
            entered[id] = resolve;
          }),
        ]),
      );
      const work = [
        Object.keys(previousLate).length
          ? sessions[0].sendCustomMessage(
              {
                customType: "controlled",
                content: "CONCURRENT_A: use spawn_child",
                display: false,
              },
              { triggerTurn: true },
            )
          : sessions[0].prompt("CONCURRENT_A: use spawn_child"),
        sessions[1].prompt("CONCURRENT_B: use spawn_child"),
      ];
      await Promise.all(Object.values(gates));
      for (const callback of Object.values(previousLate))
        assert.equal(await callback(), null);
      // Outside-session subprocesses never inherit an active session's authority.
      assert.equal(
        JSON.parse((await exec(process.execPath, args)).stdout),
        null,
      );
      for (const index of order) {
        releases[index === 0 ? "A" : "B"]();
        await work[index];
      }
      for (const [index, id] of ["A", "B"].entries()) {
        const child = children[id].at(-1);
        assert.equal(child.projectName, `project-${id}`);
        assert.equal(
          child.traceId,
          sessions[index].sessionManager.getSessionId(),
        );
        assert(child.turnId);
      }
      assert.notEqual(
        children.A.at(-1).traceWriteToken,
        children.B.at(-1).traceWriteToken,
      );
      assert.equal(process.env.SOVARA_PI_PARENT, undefined);
      previousLate = { ...late };
      const wrapper = AgentSession.prototype.prompt;
      await sessions[0].reload();
      assert.equal(
        AgentSession.prototype.prompt,
        wrapper,
        "Reload keeps one shared wrapper while B owns it",
      );
    }
    for (const callback of Object.values(previousLate))
      assert.equal(await callback(), null);
    for (const id of ["A", "B"]) {
      assert.equal(children[id].length, 2);
      assert.notEqual(children[id][0].recordingId, children[id][1].recordingId);
      assert.doesNotMatch(
        JSON.stringify(
          sessions[id === "A" ? 0 : 1].sessionManager.getEntries(),
        ),
        /traceWriteToken|CONTROLLED_TOKEN/,
      );
    }
    assert.equal(
      server.calls.filter((call) => call.path.endsWith("/prepare")).length,
      12,
    );
    assert.equal(
      server.calls.filter((call) => call.path.endsWith("/finalize")).length,
      12,
    );
  } finally {
    for (const release of Object.values(releases)) release();
    for (const session of sessions) {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    }
    assert.equal(AgentSession.prototype.prompt, originalPrompt);
    assert.equal(
      (childProcess.ChildProcess.prototype as unknown as { spawn: unknown })
        .spawn,
      originalSpawn,
    );
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
