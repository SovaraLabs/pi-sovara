import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { redact } from "./redaction.ts";

export interface Recording {
  run_id: string;
  recording_id: string;
  run_write_token: string;
  project_id: string;
}
export interface Scope {
  recording: Recording;
  turnId: string | null;
}
export interface Lesson {
  lesson_id: string;
  title: string;
  content: string;
  [key: string]: unknown;
}
export interface Retrieval {
  lessons: Lesson[];
  rendered_lessons_block: string;
  retrieval_status: string;
  [key: string]: unknown;
}
export interface Step {
  id: string;
  scope: Scope;
  api: string;
  kind: string;
  input: unknown;
  started: number;
}

export class SovaraError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Sovara ${code}${status ? ` (HTTP ${status})` : ""}`);
  }
}
function field(data: any, name: string): string {
  if (typeof data?.[name] !== "string" || !data[name])
    throw new SovaraError("invalid_response");
  return data[name];
}
export function wrapped(raw: unknown): string {
  return JSON.stringify({ raw, to_show: raw });
}

/** Narrow runner-api 4 adapter. No SDK monkey patches or provider credentials. */
export class SovaraClient {
  private compatible = false;
  private readonly secrets = new Set<string>();
  constructor(
    readonly config: Config,
    private fetcher: typeof fetch = fetch,
  ) {}

  protect(secret: string): void {
    if (secret) this.secrets.add(secret);
  }

  async connect(): Promise<void> {
    this.compatible = false;
    let response = await this.fetcher(`${this.config.execUrl}/runner/health`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (response.status === 404)
      response = await this.fetcher(`${this.config.execUrl}/health`, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    if (!response.ok) throw new SovaraError("health_failed", response.status);
    const metadata = (await response.json())?.compatibility;
    const versions = metadata?.contracts?.["runner-api"];
    if (
      metadata?.component !== "exec-server" ||
      !Array.isArray(versions) ||
      !versions.length ||
      versions.length > 64 ||
      versions.some((v) => !Number.isInteger(v) || v < 1 || v > 2147483647) ||
      new Set(versions).size !== versions.length ||
      !versions.includes(4)
    ) {
      throw new SovaraError("incompatible_runner_api");
    }
    this.compatible = true;
  }

  private async request(
    path: string,
    body: unknown,
    recording?: Recording,
    signal?: AbortSignal,
    timeout = 10000,
  ): Promise<any> {
    if (!this.compatible) throw new SovaraError("not_connected");
    const response = await this.fetcher(`${this.config.execUrl}${path}`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
      headers: {
        "content-type": "application/json",
        "x-sovara-component": "pi-extension",
        "x-sovara-version": "0.1.0",
        "x-sovara-contract": "runner-api",
        "x-sovara-contract-version": "4",
        ...(recording
          ? { "x-sovara-run-token": recording.run_write_token }
          : this.config.authHeaders),
      },
      body: JSON.stringify(
        redact(body, [
          ...this.secrets,
          ...Object.values(this.config.authHeaders),
          recording?.run_write_token ?? "",
        ]),
      ),
    });
    // Never interpolate remote error bodies: they can contain prompts or secrets.
    if (!response.ok) throw new SovaraError("request_failed", response.status);
    return response.json();
  }

  async register(sessionId: string, cwd: string): Promise<Recording> {
    return this.recording(
      await this.request("/runner/register", {
        name: "Pi session",
        run_id: `pi:${sessionId}`,
        project_name: this.config.projectName,
        project_root: cwd,
        code_version: null,
      }),
    );
  }
  private recording(data: any): Recording {
    this.protect(field(data, "run_write_token"));
    return {
      run_id: field(data, "run_id"),
      recording_id: field(data, "recording_id"),
      run_write_token: field(data, "run_write_token"),
      project_id: field(data, "project_id"),
    };
  }
  async subrun(parent: Scope, sessionId: string): Promise<Recording> {
    const data = await this.request(
      "/runner/subrun",
      {
        parent_run_id: parent.recording.run_id,
        turn_id: parent.turnId,
        name: `Pi subagent ${sessionId}`,
        lesson_scope_paths: null,
      },
      parent.recording,
    );
    return this.recording({ ...data, project_id: parent.recording.project_id });
  }
  async turn(recording: Recording, input: string): Promise<Scope> {
    const data = await this.request(
      "/runner/turns",
      { run_id: recording.run_id, turn_input: input },
      recording,
    );
    if (
      data.run_id !== recording.run_id ||
      data.recording_id !== recording.recording_id
    )
      throw new SovaraError("invalid_turn_identity");
    return { recording, turnId: field(data, "turn_id") };
  }
  async close(recording: Recording): Promise<void> {
    await this.request(
      "/runner/deregister",
      { run_id: recording.run_id },
      recording,
    );
  }
  async io(
    scope: Scope,
    kind: "input" | "output",
    value: unknown,
  ): Promise<void> {
    await this.request(
      "/runner/run-io",
      {
        run_id: scope.recording.run_id,
        turn_id: scope.turnId,
        kind,
        value: typeof value === "string" ? value : JSON.stringify(value),
      },
      scope.recording,
    );
  }
  async retrieve(
    scope: Scope,
    context: string,
    signal?: AbortSignal,
  ): Promise<Retrieval> {
    const data = await this.request(
      "/internal/lessons/retrieve",
      {
        run_id: scope.recording.run_id,
        turn_id: scope.turnId,
        raw_context: context,
        ignore_lesson_ids: [],
        scope_paths: null,
      },
      scope.recording,
      signal,
      15000,
    );
    if (
      !Array.isArray(data.lessons) ||
      typeof data.rendered_lessons_block !== "string" ||
      data.lessons.some(
        (l: any) =>
          typeof l.lesson_id !== "string" || typeof l.content !== "string",
      )
    )
      throw new SovaraError("invalid_retrieval");
    return data;
  }
  async prepare(
    scope: Scope,
    api: string,
    kind: "llm" | "tool" | "mcp",
    input: unknown,
  ): Promise<Step> {
    const id = randomUUID();
    const started = Date.now();
    const data = await this.request(
      "/internal/runner/llm/prepare",
      {
        run_id: scope.recording.run_id,
        turn_id: scope.turnId,
        step_uuid: id,
        api_type: api,
        step_kind: kind,
        input_json: wrapped(redact(input, [])),
        prepare_runtime_lessons: false,
        prompt_bearing_suffix_json: "[]",
      },
      scope.recording,
    );
    if (data.step_uuid !== id) throw new SovaraError("invalid_step_identity");
    return { id, scope, api, kind, input, started };
  }
  async finish(
    step: Step,
    output: unknown,
    errorType?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "/internal/runner/llm/finalize",
      {
        run_id: step.scope.recording.run_id,
        turn_id: step.scope.turnId,
        step_uuid: step.id,
        api_type: step.api,
        step_kind: step.kind,
        input_json: wrapped(redact(step.input, [])),
        output_json: wrapped(redact(output, [])),
        status: errorType ? "error" : "success",
        error_json: errorType
          ? JSON.stringify({ type: errorType, message: errorType })
          : null,
        latency_seconds: (Date.now() - step.started) / 1000,
        lesson_metadata: metadata ?? null,
      },
      step.scope.recording,
    );
  }
}
