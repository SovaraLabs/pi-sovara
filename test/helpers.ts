import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.ts";

export function completion(
  response: ServerResponse,
  content = "ACK",
  tool?: { name: string; arguments: Record<string, unknown> },
): void {
  response.setHeader("content-type", "text/event-stream");
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "tool-1",
            type: "function",
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
      }
    : { role: "assistant", content };
  response.end(
    `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
  );
}
export async function fixtureServer() {
  const calls: { path: string; body: any; headers: Record<string, unknown> }[] =
    [];
  let rejectPath = "",
    versions: unknown = [5],
    blockPath = "",
    reached: (() => void) | undefined;
  let handler: (body: any, response: ServerResponse) => void = (
    _body,
    response,
  ) => completion(response);
  const scopes = new Map<string, unknown>();
  const active = new Map<string, any>();
  let serial = 0,
    lessons = true;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = request.url!;
    calls.push({ path, body, headers: request.headers });
    if (path === blockPath) {
      blockPath = "";
      reached?.();
      return;
    }
    if (path === rejectPath) {
      response
        .writeHead(503)
        .end(JSON.stringify({ detail: "PRIVATE ERROR PAYLOAD" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    let result: any = { ok: true };
    if (path === "/v1/chat/completions") {
      handler(body, response);
      return;
    }
    if (path === "/runner/health")
      result = {
        status: "ok",
        service: "sovara-exec-server",
        features: { child_attachment_scope: true },
        compatibility: {
          component: "exec-server",
          product_version: "1.0.0",
          contracts: { "runner-api": versions },
        },
      };
    if (
      [
        "/runner/register",
        "/runner/subtrace",
        "/runner/subtrace/attach",
      ].includes(path)
    ) {
      const trace = body.trace_id ?? `sovara-fixture-${++serial}`;
      result = active.get(trace);
      if (path !== "/runner/subtrace/attach" || !result) {
        result = {
          trace_id: trace,
          recording_id: randomUUID(),
          trace_write_token: `CONTROLLED_TOKEN_${randomUUID()}`,
          project_id: "project-fixture",
          reused: false,
        };
        active.set(trace, result);
      } else result = { ...result, reused: true };
      if (path === "/runner/subtrace")
        scopes.set(trace, body.lesson_scope_paths);
      if (path === "/runner/subtrace/attach")
        result = { ...result, lesson_scope_paths: scopes.get(trace) };
    }
    if (path === "/runner/turns")
      result = {
        trace_id: body.trace_id,
        recording_id: active.get(body.trace_id)?.recording_id,
        turn_id: randomUUID(),
      };
    if (path.endsWith("/prepare")) {
      const input = JSON.parse(body.input_json),
        prepared = structuredClone(input);
      if (
        body.api_type === "httpx.Client.send" &&
        lessons &&
        Array.isArray(prepared.raw?.body?.messages)
      )
        prepared.raw.body.messages.push({
          role: "system",
          content: `TEMPORARY_LESSON_${++serial}`,
        });
      result = {
        step_uuid: randomUUID(),
        step_kind: body.step_kind ?? "llm",
        prepared_input_json: JSON.stringify(prepared),
        prepared_raw_input: prepared.raw,
      };
    }
    if (path === "/runner/deregister") active.delete(body.trace_id);
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config: Config = {
    projectName: "fixture",
    execUrl: url,
    autoStartLocal: false,
    connectionKind: "override",
    authentication: "sdk-managed",
  };
  return {
    calls,
    config,
    url,
    reject: (path: string) => {
      rejectPath = path;
    },
    versions: (value: unknown) => {
      versions = value;
    },
    lessons: (value: boolean) => {
      lessons = value;
    },
    provider: (value: typeof handler) => {
      handler = value;
    },
    blockNext: (path: string) => {
      blockPath = path;
      return new Promise<void>((resolve) => {
        reached = resolve;
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
