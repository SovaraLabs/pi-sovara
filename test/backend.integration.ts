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
        execUrl,
        authHeaders: {},
        autoStartLocal: false,
      };
      let retrievalResponse: unknown;
      const client = new SovaraClient(config, async (input, init) => {
        if (
          String(input).endsWith("/internal/lessons/retrieve") &&
          retrievalResponse
        )
          return Response.json(retrievalResponse);
        return fetch(input, init);
      });
      const headers = {
        "x-sovara-component": "pi-extension",
        "x-sovara-contract": "runner-api",
        "x-sovara-contract-version": "4",
      };
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
      await recorder.prepareContext([
        { role: "user", content: "First turn", timestamp: 1 },
      ]);
      await recorder.beginGeneration(
        {
          model: "gpt-test",
          messages: [{ role: "user", content: "First turn" }],
        },
        { id: "gpt-test", provider: "openai" },
      );
      await recorder.endGeneration({
        role: "assistant",
        api: "openai-completions",
        provider: "test",
        model: "gpt-test",
        timestamp: 1,
        content: [{ type: "text", text: "Synthetic answer" }],
        usage: {
          input: 12,
          output: 7,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 21,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
      const seed = await fetch(
        `${execUrl}/health/test-lessons/${recorder.scope!.recording.project_id}`,
        { method: "POST", headers },
      );
      assert.equal(seed.status, 200);
      const seeded = await seed.json();
      retrievalResponse = {
        lessons: seeded,
        rendered_lessons_block: "",
        retrieval_status: "complete",
        model_used: "synthetic-helper",
        latency_tier: "HIGH",
      };
      const injected = await recorder.prepareContext([
        { role: "user", content: "Add Micron?", timestamp: 2 },
      ]);
      await recorder.beginGeneration(
        { messages: injected, attempt: 1 },
        { id: "gpt-test", provider: "openai" },
      );
      await recorder.beginGeneration(
        { messages: injected, attempt: 2 },
        { id: "gpt-test", provider: "openai" },
      );
      await recorder.endGeneration({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Check the sector limit and investment horizon.",
          },
        ],
        stopReason: "stop",
      } as Parameters<Recorder["endGeneration"]>[0]);
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
          tree.steps?.length === 4 &&
          tree.lesson_details?.length === 3 &&
          tree.turns?.length === 2
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(tree.turns.length, 2);
      assert.equal(tree.steps.length, 4);
      assert.equal(
        tree.steps.filter((step: any) => step.api_type === "sovara.trace")
          .length,
        1,
      );
      assert.equal(tree.lesson_details.length, 3);
      const llm = tree.steps.find((step: any) => step.api_type === "pi.llm");
      assert.ok(llm);
      assert.equal(
        JSON.parse(llm.output_json).raw.content[0].text,
        "Synthetic answer",
      );
      assert.equal(JSON.parse(llm.input_json).raw.body.model, "gpt-test");
      const input = JSON.parse(llm.input_json);
      assert.equal(input.to_show.body.messages[0].content, "First turn");
      assert.equal(input.to_show.provider_payload, undefined);
      assert.equal(input.to_show.lesson_retrieval, undefined);
      const empty = tree.lesson_details.find(
        (record: any) => record.step_uuid === llm.step_uuid,
      );
      assert.deepEqual(empty.applied_lessons, []);
      assert.ok(empty.warning_message);
      assert.equal(empty.retrieval_status, "complete");
      const applied = tree.lesson_badges.filter(
        (record: any) => record.step_uuid !== llm.step_uuid,
      );
      assert.equal(applied.length, 2);
      for (const record of applied) {
        assert.equal(record.applied_lessons.length, 2);
        assert.deepEqual(
          record.applied_lessons.map((lesson: any) => [
            lesson.title,
            lesson.summary,
          ]),
          seeded.map((lesson: any) => [lesson.title, lesson.summary]),
        );
        assert.equal(
          tree.steps.find((step: any) => step.step_uuid === record.step_uuid)
            .api_type,
          "pi.llm",
        );
        const detail = tree.lesson_details.find(
          (detail: any) => detail.step_uuid === record.step_uuid,
        );
        assert.equal(
          detail.rendered_lessons_block,
          (injected.at(-1) as any).content,
        );
        assert.equal(detail.model, "synthetic-helper");
        assert.ok(detail.retrieval_latency_ms >= 0);
      }
      assert.equal(
        new Set(tree.lesson_details.map((r: any) => r.retrieval_id)).size,
        3,
      );
      const tool = tree.steps.find((step: any) => step.name === "Read");
      assert.match(JSON.stringify(tool.display_output), /example contents/);
      assert.ok(
        !tree.lesson_details.some(
          (record: any) => record.step_uuid === tool.step_uuid,
        ),
      );
      assert.equal(input.raw.lesson_retrieval, undefined);
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
