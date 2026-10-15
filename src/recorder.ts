import type { SovaraClient, Scope, Step, Retrieval } from "./client.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  cleanMessages,
  lessonBlock,
  referenceMessage,
  RetrievalSuffix,
} from "./lessons.ts";

interface RetrievalObservation {
  status: string;
  query?: string;
  result?: Retrieval;
  step_uuid?: string;
  injected_lesson_ids?: string[];
  query_truncated?: boolean;
  injection_truncated?: boolean;
}

/** Pi reports uncached input separately, matching Sovara's normalized token columns. */
export function withUsage(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("usage" in value)) return value;
  const usage = value.usage;
  if (!usage || typeof usage !== "object") return value;
  return {
    ...value,
    usage: {
      ...usage,
      ...("input" in usage && typeof usage.input === "number"
        ? { input_tokens: usage.input }
        : {}),
      ...("output" in usage && typeof usage.output === "number"
        ? { output_tokens: usage.output }
        : {}),
      ...("cacheRead" in usage && typeof usage.cacheRead === "number"
        ? { cache_read_input_tokens: usage.cacheRead }
        : {}),
      ...("cacheWrite" in usage && typeof usage.cacheWrite === "number"
        ? { cache_creation_input_tokens: usage.cacheWrite }
        : {}),
    },
  };
}

export class Recorder {
  scope?: Scope;
  private generation?: Step;
  private readonly tools = new Map<string, Step>();
  private context: AgentMessage[] = [];
  private retrieval?: RetrievalObservation;
  private readonly suffix: RetrievalSuffix;
  private readonly exportErrors: unknown[] = [];
  private firstTokenAt?: number;
  private finalOutput: unknown = "";
  private turnSignal?: AbortSignal;

  constructor(
    readonly client: SovaraClient,
    readonly config: Config,
    readonly sessionId: string,
    readonly cwd: string,
    readonly parent?: Scope,
    readonly parentSession?: string,
  ) {
    this.suffix = new RetrievalSuffix((value) => client.sanitize(value));
  }

  setContext(messages: AgentMessage[]): void {
    this.context = structuredClone(messages);
  }

  noteFirstToken(): void {
    if (this.generation && this.firstTokenAt === undefined)
      this.firstTokenAt = Date.now();
  }

  async prepareContext(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const clean = cleanMessages(messages);
    this.setContext(clean);
    const query = this.suffix.context(clean);
    const result = await this.retrieve(query.context, signal);
    const block = lessonBlock(result);
    this.retrieval = {
      ...this.retrieval!,
      injected_lesson_ids: block.ids,
      query_truncated: query.truncated,
      injection_truncated: block.truncated,
    };
    const prepared = block.text
      ? [...clean, referenceMessage(block.text)]
      : clean;
    // Exact injected text is already in the captured context; keep it in one place.
    this.setContext(prepared);
    return prepared;
  }

  takeExportErrors(): unknown[] {
    return this.exportErrors.splice(0);
  }

  private async attemptExport<T>(
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.exportErrors.push(error);
      return undefined;
    }
  }

  async start(input: unknown, signal?: AbortSignal): Promise<void> {
    if (this.scope) await this.close("Superseded");
    signal?.throwIfAborted();
    this.turnSignal = signal;
    this.finalOutput = "";
    this.retrieval = undefined;
    this.context = [];
    const recording = this.parent
      ? await this.client.subrun(this.parent, this.sessionId, signal)
      : await this.client.register(this.sessionId, this.cwd, signal);
    // Retain credentials even if declaring the turn fails, so shutdown can close it.
    this.scope = { recording, turnId: null };
    this.scope = await this.client.turn(recording, input, signal);
    const scope = this.scope;
    await this.attemptExport(() =>
      this.client.io(scope, "input", input, signal),
    );
    signal?.throwIfAborted();
  }

  async retrieve(context: string, signal?: AbortSignal): Promise<Retrieval> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    const scope = this.scope;
    if (!scope?.turnId) throw new Error("No active Sovara turn");
    const step = await this.attemptExport(() =>
      this.client.prepare(
        scope,
        "sovara.trace",
        "tool",
        {
          tool_name: "Sovara lesson retrieval",
          context,
          source: "pi-extension",
        },
        signal,
      ),
    );
    let result: Retrieval;
    try {
      signal?.throwIfAborted();
      result = await this.client.retrieve(scope, context, signal);
      this.retrieval = {
        status: result.retrieval_status,
        query: context,
        result,
      };
    } catch (error) {
      this.retrieval = { status: "failed" };
      if (step) {
        await this.attemptExport(() =>
          this.client.finish(
            step,
            { status: "failed" },
            "RetrievalFailed",
            undefined,
            signal?.aborted ? AbortSignal.timeout(1000) : signal,
          ),
        );
      }
      throw error;
    }
    if (step) {
      const exported = await this.attemptExport(async () => {
        await this.client.finish(step, result, undefined, undefined, signal);
        return true;
      });
      // Keep full fallback evidence until the observation export is acknowledged.
      if (exported)
        this.retrieval = {
          status: result.retrieval_status,
          step_uuid: step.id,
        };
    }
    signal?.throwIfAborted();
    return result;
  }

  async beginGeneration(
    payload: unknown,
    model: { id: string; provider: string } | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    if (!this.scope?.turnId) return;
    if (this.generation) {
      const previous = this.generation;
      this.generation = undefined;
      await this.attemptExport(() =>
        this.client.finish(
          previous,
          { status: "superseded" },
          "ProviderRetry",
          undefined,
          signal,
        ),
      );
      signal?.throwIfAborted();
    }
    this.firstTokenAt = undefined;
    this.generation = await this.client.prepare(
      this.scope,
      "pi.llm",
      "llm",
      {
        body: { model: model?.id, messages: this.context },
        provider: model?.provider,
        provider_payload: payload,
        capture: "pi-provider-hook",
        lesson_retrieval: this.retrieval ?? null,
        pi_session_id: this.sessionId,
        parent_session: this.parentSession,
      },
      signal,
    );
  }
  async endGeneration(
    message: AssistantMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    this.finalOutput = structuredClone(message.content);
    if (!this.generation) return;
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    const step = this.generation;
    this.generation = undefined;
    const error = ["error", "aborted"].includes(message.stopReason)
      ? message.stopReason
      : undefined;
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
      undefined,
      signal,
    );
  }
  async beginTool(
    id: string,
    name: string,
    args: unknown,
    parentToolCallId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    if (!this.scope?.turnId) return;
    const isMcp = name.startsWith("mcp__");
    const input = {
      tool_name: name,
      tool_input: args,
      tool_call_id: id,
      parent_tool_call_id: parentToolCallId,
      ...(isMcp ? { root: { params: { name, arguments: args } } } : {}),
    };
    const step = await this.client.prepare(
      this.scope,
      isMcp ? "MCP.ClientSession.send_request" : "sovara.trace",
      isMcp ? "mcp" : "tool",
      input,
      signal,
    );
    this.tools.set(id, step);
  }
  async endTool(
    id: string,
    result: unknown,
    failed: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    this.turnSignal = signal ?? this.turnSignal;
    signal?.throwIfAborted();
    const step = this.tools.get(id);
    if (!step) return;
    this.tools.delete(id);
    await this.client.finish(
      step,
      result,
      failed ? "ToolError" : undefined,
      undefined,
      signal,
    );
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
    // One budget for the whole close, shortened to one second on cancellation.
    const controller = new AbortController();
    const deadline = Date.now() + 10000;
    let timer = setTimeout(() => controller.abort(), 10000);
    const cancelled = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(),
        Math.max(0, Math.min(1000, deadline - Date.now())),
      );
    };
    const parent = this.turnSignal;
    if (parent?.aborted) cancelled();
    else parent?.addEventListener("abort", cancelled, { once: true });
    const signal = controller.signal;
    try {
      await Promise.all(
        pending.map((step) =>
          this.attemptExport(() =>
            this.client.finish(
              step,
              { status: "interrupted" },
              reason ?? "Interrupted",
              undefined,
              signal,
            ),
          ),
        ),
      );
      await this.attemptExport(() =>
        this.client.io(scope, "output", this.finalOutput, signal),
      );
      await this.attemptExport(() =>
        this.client.close(scope.recording, signal),
      );
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancelled);
      this.turnSignal = undefined;
    }
  }
}
