import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { SovaraClient, type Scope } from "./client.ts";
import { Recorder, withUsage } from "./recorder.ts";
import { connectionDetails, explainError } from "./diagnostics.ts";

const PARENT_ENV = "SOVARA_PI_PARENT";
const CONFIG_ENTRY = "sovara-config-v1";

interface Parent {
  url: string;
  projectName: string;
  scope: Scope;
}
function inheritedParent(): Parent | undefined {
  const raw = process.env[PARENT_ENV];
  if (!raw) return;
  const value = JSON.parse(raw) as Parent;
  if (
    !value.url ||
    !value.projectName ||
    !value.scope?.recording?.run_write_token ||
    !value.scope.turnId
  ) {
    throw new Error("Invalid Sovara parent context");
  }
  return value;
}

export default function sovara(pi: ExtensionAPI): void {
  let recorder: Recorder | undefined;
  let selectedConfig: Config | undefined;
  let lastError: string | undefined;
  let operationFailed = false;
  let lastRetrievalWarning: string | undefined;
  let summaryCapture:
    | { started: number; payload?: unknown; signal?: AbortSignal }
    | undefined;
  const originalParent = process.env[PARENT_ENV];
  const restoreParent = () => {
    if (originalParent === undefined) delete process.env[PARENT_ENV];
    else process.env[PARENT_ENV] = originalParent;
  };
  const status = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.setStatus("sovara", `sovara: ${text}`);
  };
  const report = (ctx: ExtensionContext, error: unknown) => {
    lastError = explainError(error, selectedConfig);
    if (!operationFailed) {
      if (ctx.hasUI) ctx.ui.notify(lastError, "warning");
      else console.error(`[sovara-pi] ${lastError}`);
    }
    operationFailed = true;
    status(ctx, "operation failed — /sovara for details");
  };
  const guarded = async (ctx: ExtensionContext, work: () => Promise<void>) => {
    const active = recorder;
    try {
      await work();
    } catch (error) {
      report(ctx, error);
    } finally {
      for (const current of new Set([active, recorder]))
        for (const error of current?.takeExportErrors() ?? [])
          report(ctx, error);
    }
  };
  async function cleanup(): Promise<void> {
    restoreParent();
    const previous = recorder;
    recorder = undefined;
    summaryCapture = undefined;
    await previous?.close("SessionClosed");
  }

  pi.registerCommand("sovara", {
    description: "Show Sovara project and recording status",
    handler: async (_args, ctx) => {
      const lines = selectedConfig
        ? connectionDetails(selectedConfig, !!recorder)
        : ["Sovara configuration could not be loaded."];
      lines.push(
        `Recording: ${recorder ? (recorder.scope ? "active" : "idle") : "unavailable"}`,
      );
      if (recorder?.retrievalWarning)
        lines.push(`Lessons: ${recorder.retrievalWarning}`);
      if (lastError) lines.push(`Last error: ${lastError}`);
      ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    let initialized = false;
    await guarded(ctx, async () => {
      await cleanup();
      operationFailed = false;
      selectedConfig = undefined;
      lastError = undefined;
      lastRetrievalWarning = undefined;
      const config = await loadConfig(
        ctx.cwd,
        undefined,
        undefined,
        ctx.isProjectTrusted(),
      );
      selectedConfig = config;
      const parent = inheritedParent();
      // A resumed session keeps its original project binding.
      const entries = ctx.sessionManager.getEntries();
      const saved = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === CONFIG_ENTRY,
        );
      if (
        saved?.type === "custom" &&
        event.reason !== "fork" &&
        event.reason !== "new"
      ) {
        const data = saved.data as {
          projectName?: unknown;
        };
        if (typeof data?.projectName !== "string" || !data.projectName)
          throw new Error("Invalid session binding");
        config.projectName = data.projectName;
      }
      if (parent) {
        if (parent.url !== config.execUrl)
          throw new Error("Subagent Sovara server differs from parent");
        config.projectName = parent.projectName;
      }
      const client = new SovaraClient(config);
      if (parent) client.protect(parent.scope.recording.run_write_token);
      await client.connect();
      const header = ctx.sessionManager.getHeader();
      recorder = new Recorder(
        client,
        config,
        ctx.sessionManager.getSessionId(),
        ctx.cwd,
        parent?.scope,
        header?.parentSession,
      );
      if (!saved || event.reason === "fork" || event.reason === "new") {
        pi.appendEntry(CONFIG_ENTRY, {
          projectName: config.projectName,
        });
      }
      status(ctx, config.projectName);
      initialized = true;
    });
    if (!initialized) await guarded(ctx, cleanup);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!recorder) return;
    summaryCapture = undefined;
    restoreParent();
    await guarded(ctx, async () => {
      operationFailed = false;
      lastError = undefined;
      await recorder!.start(
        event.messageType === "user" ? event.prompt : event.message.content,
        ctx.signal,
      );
      process.env[PARENT_ENV] = JSON.stringify({
        url: recorder!.config.execUrl,
        projectName: recorder!.config.projectName,
        scope: recorder!.scope!,
      } satisfies Parent);
      status(ctx, `${recorder!.config.projectName} · recording`);
    });
  });

  pi.on("context_with_system", async (event, ctx) => {
    const active = recorder;
    if (!active?.scope?.turnId || summaryCapture) return;
    let messages = event.messages;
    await guarded(ctx, async () => {
      messages = await active.prepareContext(messages, ctx.signal);
      const warning = active.retrievalWarning;
      if (warning && warning !== lastRetrievalWarning) {
        if (ctx.hasUI) ctx.ui.notify(`Sovara: ${warning}`, "warning");
        else console.error(`[sovara-pi] ${warning}`);
      }
      lastRetrievalWarning = warning;
    });
    return { messages };
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (summaryCapture) {
      summaryCapture.payload = structuredClone(event.payload);
      return;
    }
    await guarded(ctx, async () => {
      await recorder?.beginGeneration(
        structuredClone(event.payload),
        ctx.model,
        ctx.signal,
      );
    });
  });
  pi.on("message_update", (event) => {
    if (
      ["text_delta", "thinking_delta", "toolcall_delta"].includes(
        event.assistantMessageEvent.type,
      )
    )
      recorder?.noteFirstToken();
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role === "assistant")
      await guarded(ctx, async () => {
        await recorder?.endGeneration(message, ctx.signal);
      });
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.beginTool(
        event.toolCallId,
        event.toolName,
        structuredClone(event.args),
        event.parentToolCallId,
        ctx.signal,
      );
    });
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.endTool(
        event.toolCallId,
        structuredClone(event.result),
        event.isError,
        ctx.signal,
      );
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    restoreParent();
    await guarded(ctx, async () => {
      await recorder?.close();
    });
    if (recorder)
      status(
        ctx,
        operationFailed
          ? "export incomplete"
          : recorder.retrievalWarning
            ? "turn export acknowledged · lesson retrieval warning"
            : "turn export acknowledged",
      );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await guarded(ctx, cleanup);
  });

  async function summary(
    name: string,
    entry: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    const captured = summaryCapture;
    summaryCapture = undefined;
    if (!entry || !recorder) return;
    const active = recorder;
    const ownsTurn = !active.scope;
    const signal = captured?.signal?.aborted
      ? AbortSignal.timeout(1000)
      : (ctx.signal ?? AbortSignal.timeout(10000));
    await guarded(ctx, async () => {
      try {
        if (ownsTurn) await active.start(name, signal);
        const step = await active.client.prepare(
          active.scope!,
          "pi.summary",
          "llm",
          {
            body: { model: ctx.model?.id },
            summary_kind: name,
            capture: "pi-summary-event",
            provider_payload: captured?.payload,
            input_unavailable: captured?.payload === undefined,
          },
          signal,
        );
        if (captured) step.started = captured.started;
        await active.client.finish(
          step,
          withUsage(entry),
          (entry as { status?: string }).status === "error"
            ? "SummaryFailed"
            : undefined,
          signal,
        );
      } finally {
        if (ownsTurn) await active.close();
      }
    });
  }
  pi.on("session_before_compact", (event) => {
    summaryCapture = { started: Date.now(), signal: event.signal };
  });
  pi.on("session_before_tree", (event) => {
    summaryCapture = event.preparation.userWantsSummary
      ? { started: Date.now(), signal: event.signal }
      : undefined;
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    await summary(
      "Compaction failed",
      { aborted: event.aborted, status: "error" },
      ctx,
    );
  });
  pi.on("session_compact", async (event, ctx) => {
    await summary("Compaction", event.compactionEntry, ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    await summary("Branch summary", event.summaryEntry, ctx);
  });
}
