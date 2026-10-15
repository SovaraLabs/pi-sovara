import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { SovaraClient } from "../src/client.ts";
import { Recorder } from "../src/recorder.ts";

test(
  "real Sovara backend persists the plugin's trace, turns, tools and retrieval",
  { timeout: 60000 },
  async () => {
    const source = process.env.SOVARA_SOURCE_DIR;
    assert.ok(
      source,
      "Set SOVARA_SOURCE_DIR to a Sovara checkout with uv sync completed",
    );
    const child = spawn(
      join(source, ".venv", "bin", "python"),
      [resolve("test/backend-server.py")],
      { cwd: source, stdio: ["ignore", "pipe", "pipe"] },
    );
    let diagnostics = "";
    child.stderr.on("data", (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-3000);
    });
    try {
      const [chunk] = await once(child.stdout, "data");
      const execUrl = chunk.toString().trim();
      assert.match(execUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      const config = {
        projectName: "pi-contract-test",
        lessonMode: "automatic" as const,
        execUrl,
        authHeaders: {},
      };
      const client = new SovaraClient(config);
      let connected = false;
      for (let i = 0; i < 100; i++) {
        try {
          await client.connect();
          connected = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (child.exitCode !== null) break;
      }
      assert.ok(connected, `Backend did not start: ${diagnostics}`);
      const recorder = new Recorder(
        client,
        config,
        "durable-session",
        "/synthetic-project",
      );
      await recorder.start("First turn");
      const runId = recorder.scope!.recording.run_id;
      const lessons = await recorder.retrieve(
        "Synthetic task with no lessons",
        true,
      );
      assert.equal(lessons.lessons.length, 0);
      await recorder.beginGeneration(
        {
          model: "gpt-test",
          messages: [{ role: "user", content: "First turn" }],
        },
        { id: "gpt-test", provider: "openai" },
      );
      await recorder.endGeneration({
        role: "assistant",
        content: [{ type: "text", text: "Synthetic answer" }],
        usage: {
          input: 12,
          output: 7,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 21,
        },
        stopReason: "stop",
      });
      await recorder.beginTool("read-1", "read", { path: "example.txt" });
      await recorder.endTool(
        "read-1",
        { content: [{ type: "text", text: "example contents" }] },
        false,
      );
      await recorder.close();
      await recorder.start("Resumed turn");
      assert.equal(recorder.scope!.recording.run_id, runId);
      await recorder.close();
      let tree: any;
      for (let i = 0; i < 100; i++) {
        const response = await fetch(`${execUrl}/health/test-run/${runId}`, {
          headers: {
            "x-sovara-component": "pi-extension",
            "x-sovara-contract": "runner-api",
            "x-sovara-contract-version": "4",
          },
        });
        tree = await response.json();
        if (
          tree.steps?.length === 3 &&
          tree.steps.every((s: any) => s.status === "success") &&
          tree.turns?.length === 2
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(tree.turns.length, 2);
      assert.equal(tree.steps.length, 3);
      assert.ok(tree.steps.every((step: any) => step.status === "success"));
      const llm = tree.steps.find((step: any) => step.api_type === "pi.llm");
      assert.ok(llm);
      assert.equal(
        JSON.parse(llm.output_json).raw.content[0].text,
        "Synthetic answer",
      );
      assert.equal(JSON.parse(llm.input_json).raw.body.model, "gpt-test");
      assert.equal(llm.input_tokens, 12);
      assert.equal(llm.output_tokens, 7);
      assert.equal(llm.cache_read_tokens, 2);
      assert.equal(
        tree.steps.find(
          (step: any) =>
            step.api_type === "sovara.trace" && step.name === "Read",
        )?.status,
        "success",
      );
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
  },
);
