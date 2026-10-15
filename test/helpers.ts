import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.ts";

export async function fixtureServer() {
  const calls: { path: string; body: any; headers: Record<string, unknown> }[] =
    [];
  let rejectPath = "";
  let blockedPath = "";
  let reached: (() => void) | undefined;
  let versions: unknown = [4];
  let retrieval: unknown;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url!, body, headers: req.headers });
    res.setHeader("content-type", "application/json");
    if (req.url === blockedPath) {
      blockedPath = "";
      reached?.();
      return;
    }
    if (req.url === rejectPath) {
      res
        .writeHead(503)
        .end(JSON.stringify({ detail: "PRIVATE ERROR PAYLOAD" }));
      return;
    }
    let response: unknown = { ok: true };
    switch (req.url) {
      case "/runner/health":
        response = {
          compatibility: {
            component: "exec-server",
            contracts: { "runner-api": versions },
          },
        };
        break;
      case "/runner/register":
      case "/runner/subrun":
        response = {
          run_id: "sovara-fixture",
          recording_id: randomUUID(),
          run_write_token: "recording-secret",
          project_id: "project-fixture",
        };
        break;
      case "/runner/turns": {
        const registered = calls.filter((c) =>
          ["/runner/register", "/runner/subrun"].includes(c.path),
        ).length;
        response = {
          run_id: body.run_id,
          recording_id: recordingIds[registered - 1],
          turn_id: randomUUID(),
        };
        break;
      }
      case "/internal/runner/llm/prepare":
        response = { step_uuid: body.step_uuid, step_kind: body.step_kind };
        break;
      case "/internal/lessons/retrieve":
        response = retrieval ?? {
          lessons: [
            {
              lesson_id: "lesson-1",
              title: "Tests",
              content: "Use a deterministic clock.",
            },
          ],
          rendered_lessons_block: "Use a deterministic clock.",
          retrieval_status: "complete",
        };
        break;
    }
    if (["/runner/register", "/runner/subrun"].includes(req.url!))
      recordingIds.push((response as any).recording_id);
    res.end(JSON.stringify(response));
  });
  const recordingIds: string[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config: Config = {
    projectName: "fixture",
    execUrl: `http://127.0.0.1:${address.port}`,
    authHeaders: { "x-sovara-agent-token": "agent-secret" },
    autoStartLocal: false,
  };
  return {
    calls,
    config,
    reject(path: string) {
      rejectPath = path;
    },
    blockNext(path: string): Promise<void> {
      blockedPath = path;
      return new Promise((resolve) => {
        reached = resolve;
      });
    },
    versions(value: unknown) {
      versions = value;
    },
    retrieval(value: unknown) {
      retrieval = value;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
