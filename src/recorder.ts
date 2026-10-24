import {
  SovaraClient,
  type ParentContext,
  type Recording,
  type Turn,
  type Tool,
} from "@sovara/sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "./config.ts";
import { redact } from "./redaction.ts";

const mcpResourceTools = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

/** Pi owns lifecycle and explicit tool events; the SDK owns provider requests. */
export class Recorder {
  recording?: Recording;
  turn?: Turn;
  private readonly tools = new Map<string, Tool>();
  private finalOutput: unknown = "";
  private failed = false;
  private signal?: AbortSignal;
  private readonly secrets: string[];
  private readonly errors: unknown[] = [];
  private closing?: Promise<void>;

  constructor(
    readonly client: SovaraClient,
    readonly config: Config,
    readonly sessionId: string,
    readonly parent?: ParentContext,
    private childTraceId?: string,
    private readonly saveChild?: (traceId: string) => void,
    readonly parentSession?: string,
    private readonly borrowedRecording?: Recording,
  ) {
    this.secrets = [
      process.env.SOVARA_AGENT_TOKEN ?? "",
      parent?.traceWriteToken ?? "",
    ];
  }

  takeExportErrors(): unknown[] {
    return this.errors.splice(0);
  }
  sanitize(value: unknown): unknown {
    return redact(value, this.secrets);
  }
  private async attempt(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.errors.push(error);
    }
  }

  async start(input: unknown, signal?: AbortSignal): Promise<void> {
    await this.close(true);
    signal?.throwIfAborted();
    this.signal = signal;
    this.finalOutput = "";
    this.failed = false;
    this.recording =
      this.borrowedRecording ??
      (this.parent
        ? this.childTraceId
          ? await this.client.attachChild(this.parent, this.childTraceId)
          : await this.client.startChild(this.parent, this.sessionId)
        : await this.client.startRecording(this.sessionId, {
            traceId: this.sessionId,
            captureLogs: false,
          }));
    this.secrets.push(this.recording.exportParentContext().traceWriteToken);
    try {
      if (this.parent && !this.childTraceId) {
        this.childTraceId = this.recording.traceId;
        this.saveChild?.(this.childTraceId);
      }
      signal?.throwIfAborted();
      this.turn = await this.recording.startTurn();
      await this.attempt(() =>
        this.turn!.logInput(
          this.sanitize({
            input,
            pi_session_id: this.sessionId,
            parent_session: this.parentSession,
          }),
        ),
      );
      signal?.throwIfAborted();
    } catch (error) {
      await this.close(true);
      throw error;
    }
  }

  summary(): Recorder {
    return new Recorder(
      this.client,
      this.config,
      this.sessionId,
      this.parent,
      this.childTraceId,
      (traceId) => {
        this.childTraceId = traceId;
        this.saveChild?.(traceId);
      },
      this.parentSession,
      this.recording,
    );
  }
  noteFailure(): void {
    this.failed = true;
  }
  noteSignal(signal?: AbortSignal): void {
    this.signal = signal ?? this.signal;
  }
  noteOutput(message: AssistantMessage): void {
    this.finalOutput = message.content;
    this.failed = message.stopReason === "error";
  }
  async beginTool(
    id: string,
    name: string,
    input: unknown,
    parentCallId?: string,
  ): Promise<void> {
    if (!this.turn) return;
    if (this.tools.has(id))
      throw new Error("Duplicate Pi tool call identifier");
    const tool = await this.turn.startTool({
      name,
      callId: id,
      parentCallId,
      kind:
        name.startsWith("mcp__") || mcpResourceTools.has(name) ? "mcp" : "tool",
      input: this.sanitize(input),
    });
    this.tools.set(id, tool);
  }
  async endTool(id: string, output: unknown, failed: boolean): Promise<void> {
    const tool = this.tools.get(id);
    if (!tool) return;
    this.tools.delete(id);
    const captured = this.sanitize(output);
    if (failed)
      await tool.fail(new Error("Pi tool returned an error"), {
        output: captured,
      });
    else await tool.finish(captured);
  }
  close(cancelled = false): Promise<void> {
    if (this.closing) return this.closing;
    const recording = this.recording,
      turn = this.turn;
    if (!recording) return Promise.resolve();
    this.recording = undefined;
    this.turn = undefined;
    const tools = [...this.tools.values()];
    this.tools.clear();
    const aborted = cancelled || this.signal?.aborted === true;
    this.closing = (async () => {
      await Promise.all(
        tools.map((tool) =>
          this.attempt(() => tool.cancel("Pi tool did not finish")),
        ),
      );
      if (turn) {
        await this.attempt(() =>
          turn.logOutput(this.sanitize(this.finalOutput)),
        );
        await this.attempt(() =>
          aborted
            ? turn.cancel("Pi operation cancelled")
            : this.failed
              ? turn.fail(new Error("Pi provider failed"))
              : turn.finish(),
        );
      }
      if (recording !== this.borrowedRecording)
        await this.attempt(() =>
          aborted
            ? recording.cancel("Pi operation cancelled")
            : this.failed
              ? recording.fail(new Error("Pi provider failed"))
              : recording.finish(),
        );
    })().finally(() => {
      this.closing = undefined;
      this.signal = undefined;
      this.secrets.splice(2);
    });
    return this.closing;
  }
}

export function createClient(config: Config): SovaraClient {
  return new SovaraClient({
    projectName: config.projectName,
    ...(config.autoStartLocal ? {} : { url: config.execUrl }),
    autoInstrumentation: { providerHttp: true, mcp: false },
  });
}
