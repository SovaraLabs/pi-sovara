import type { SovaraClient, Scope, Step, Retrieval } from "./client.ts";
import type { Config } from "./config.ts";

/** Pi reports uncached input separately, matching Sovara's normalized token columns. */
export function withUsage(value: any): unknown {
  if (!value?.usage) return value;
  return {
    ...value,
    usage: {
      ...value.usage,
      input_tokens: value.usage.input,
      output_tokens: value.usage.output,
      cache_read_input_tokens: value.usage.cacheRead,
      cache_creation_input_tokens: value.usage.cacheWrite,
    },
  };
}

export class Recorder {
  scope?: Scope;
  generation?: Step;
  readonly tools = new Map<string, Step>();
  context: unknown[] = [];
  retrieval?: Record<string, unknown>;
  firstTokenAt?: number;
  finalOutput: unknown = "";
  failed = false;

  constructor(
    readonly client: SovaraClient,
    readonly config: Config,
    readonly sessionId: string,
    readonly cwd: string,
    readonly parent?: Scope,
    readonly parentSession?: string,
  ) {}

  async start(input: string): Promise<void> {
    if (this.scope) await this.close("Superseded");
    this.failed = false;
    this.finalOutput = "";
    this.retrieval = undefined;
    this.context = [];
    const recording = this.parent
      ? await this.client.subrun(this.parent, this.sessionId)
      : await this.client.register(this.sessionId, this.cwd);
    // Retain credentials even if declaring the turn fails, so shutdown can close it.
    this.scope = { recording, turnId: null };
    this.scope = await this.client.turn(recording, input);
    await this.client.io(this.scope, "input", input);
  }

  async retrieve(
    context: string,
    signal?: AbortSignal,
  ): Promise<Retrieval> {
    const scope = this.scope;
    if (!scope?.turnId) throw new Error("No active Sovara turn");
    const step = await this.client.prepare(scope, "sovara.trace", "tool", {
      tool_name: "Sovara lesson retrieval",
      context,
      source: "pi-extension",
      lesson_mode: this.config.lessonMode,
    });
    try {
      const result = await this.client.retrieve(scope, context, signal);
      this.retrieval = { mode: this.config.lessonMode, query: context, result };
      await this.client.finish(step, result);
      return result;
    } catch (error) {
      this.retrieval = { mode: this.config.lessonMode, status: "failed" };
      await this.client.finish(step, { status: "failed" }, "RetrievalFailed");
      throw error;
    }
  }

  async beginGeneration(
    payload: unknown,
    model: { id: string; provider: string } | undefined,
  ): Promise<void> {
    if (!this.scope?.turnId) return;
    if (this.generation) {
      const previous = this.generation;
      this.generation = undefined;
      await this.client.finish(
        previous,
        { status: "superseded" },
        "ProviderRetry",
      );
    }
    this.firstTokenAt = undefined;
    this.generation = await this.client.prepare(this.scope, "pi.llm", "llm", {
      body: { model: model?.id, messages: this.context },
      provider: model?.provider,
      provider_payload: payload,
      capture: "pi-provider-hook",
      lesson_mode: this.config.lessonMode,
      lesson_retrieval: this.retrieval ?? null,
      pi_session_id: this.sessionId,
      parent_session: this.parentSession,
    });
  }
  async endGeneration(message: any): Promise<void> {
    if (!this.generation) return;
    const step = this.generation;
    this.generation = undefined;
    const error = ["error", "aborted"].includes(message.stopReason)
      ? message.stopReason
      : undefined;
    if (error) this.failed = true;
    this.finalOutput = message.content;
    await this.client.finish(
      step,
      withUsage({
        ...message,
        time_to_first_token_ms:
          this.firstTokenAt === undefined
            ? null
            : this.firstTokenAt - step.started,
      }),
      error,
    );
  }
  async beginTool(
    id: string,
    name: string,
    args: unknown,
    parentToolCallId?: string,
  ): Promise<void> {
    if (!this.scope?.turnId) return;
    const isMcp = name.startsWith("mcp__");
    const input = {
      tool_name: name,
      tool_input: args,
      tool_call_id: id,
      parent_tool_call_id: parentToolCallId,
      ...(isMcp ? { root: { params: { name, arguments: args } } } : {}),
      lesson_mode: this.config.lessonMode,
    };
    const step = await this.client.prepare(
      this.scope,
      isMcp ? "MCP.ClientSession.send_request" : "sovara.trace",
      isMcp ? "mcp" : "tool",
      input,
    );
    this.tools.set(id, step);
  }
  async endTool(id: string, result: unknown, failed: boolean): Promise<void> {
    const step = this.tools.get(id);
    if (!step) return;
    this.tools.delete(id);
    if (failed) this.failed = true;
    await this.client.finish(step, result, failed ? "ToolError" : undefined);
  }
  async close(reason?: string): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    this.scope = undefined;
    const pending = [
      ...this.tools.values(),
      ...(this.generation ? [this.generation] : []),
    ];
    this.tools.clear();
    this.generation = undefined;
    try {
      const results = await Promise.allSettled(
        pending.map((step) =>
          this.client.finish(
            step,
            { status: "interrupted" },
            reason ?? "Interrupted",
          ),
        ),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Incomplete Sovara export");
      await this.client.io(scope, "output", this.finalOutput);
    } finally {
      await this.client.close(scope.recording);
    }
  }
}
