import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadConfig,
  mode,
  saveMode,
  type LessonMode,
} from "./config.ts";
import { SovaraClient, SovaraError, type Scope } from "./client.ts";
import { Recorder, withUsage } from "./recorder.ts";
import {
  cleanMessages,
  lessonBlock,
  LESSON_MESSAGE,
  needsReminder,
  referenceMessage,
  REMINDER,
  REMINDER_MESSAGE,
  RetrievalSuffix,
  SYSTEM_INSTRUCTION,
} from "./lessons.ts";

const PARENT_ENV = "SOVARA_PI_PARENT";
const CONFIG_ENTRY = "sovara-config-v1";

interface Parent {
  url: string;
  projectName: string;
  lessonMode: LessonMode;
  scope: Scope;
  sessionId: string;
}
function inheritedParent(): Parent | undefined {
  const raw = process.env[PARENT_ENV];
  if (!raw) return;
  const value = JSON.parse(raw) as Parent;
  mode(value.lessonMode);
  if (
    !value.url ||
    !value.projectName ||
    !value.scope?.recording?.run_write_token ||
    !value.scope.turnId ||
    !value.sessionId
  ) {
    throw new Error("Invalid Sovara parent context");
  }
  return value;
}

export default function sovara(pi: ExtensionAPI): void {
  let recorder: Recorder | undefined;
  let retrievalSuffix = new RetrievalSuffix();
  let exportFailed = false;
  let summaryPending = false;
  let summaryStartedAt: number | undefined;
  let summaryPayload: unknown;
  const originalParent = process.env[PARENT_ENV];
  const restoreParent = () => {
    if (originalParent === undefined) delete process.env[PARENT_ENV];
    else process.env[PARENT_ENV] = originalParent;
  };
  const status = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.setStatus("sovara", `sovara: ${text}`);
  };
  const report = (ctx: ExtensionContext, error: unknown) => {
    if (!ctx.hasUI && !exportFailed)
      console.error(
        `[sovara-pi] ${error instanceof SovaraError ? error.message : "operation failed"}; recording or retrieval may be incomplete`,
      );
    exportFailed = true;
    status(
      ctx,
      error instanceof SovaraError ? error.message : "operation failed",
    );
  };
  const guarded = async (ctx: ExtensionContext, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      report(ctx, error);
    }
  };
  async function cleanup(): Promise<void> {
    restoreParent();
    const previous = recorder;
    recorder = undefined;
    retrievalSuffix = new RetrievalSuffix();
    await previous?.close("SessionClosed");
  }

  pi.registerCommand("sovara", {
    description:
      "Show Sovara status, or set mode automatic|mcp-reminder|mcp-system for new sessions",
    handler: async (args, ctx) => {
      if (args.trim().startsWith("mode ")) {
        try {
          const next = mode(args.trim().slice(5));
          await saveMode(ctx.cwd, next);
          ctx.ui.notify(
            `Sovara mode saved: ${next}. Start /new to use it; this session keeps its current mode.`,
            "info",
          );
        } catch {
          ctx.ui.notify(
            "Use /sovara mode automatic|mcp-reminder|mcp-system. The project config must be writable.",
            "error",
          );
        }
      } else {
        ctx.ui.notify(
          recorder
            ? `Project: ${recorder.config.projectName}\nMode: ${recorder.config.lessonMode}\nRecording: ${recorder.scope ? "active" : "idle"}${exportFailed ? "\nA Sovara operation failed; export may be incomplete." : ""}`
            : "Sovara is unavailable. Check your connection and reload.",
          "info",
        );
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    let initialized = false;
    await guarded(ctx, async () => {
      await cleanup();
      exportFailed = false;
      const config = await loadConfig(
        ctx.cwd,
        undefined,
        undefined,
        ctx.isProjectTrusted(),
      );
      const parent = inheritedParent();
      // A resumed session keeps its experiment assignment, even after a mode change.
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
          lessonMode?: unknown;
        };
        if (typeof data?.projectName !== "string" || !data.projectName)
          throw new Error("Invalid session binding");
        config.projectName = data.projectName;
        config.lessonMode = mode(data.lessonMode);
      }
      if (parent) {
        if (parent.url !== config.execUrl)
          throw new Error("Subagent Sovara server differs from parent");
        config.projectName = parent.projectName;
        config.lessonMode = parent.lessonMode;
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
          lessonMode: config.lessonMode,
        });
      }
      status(ctx, `${config.projectName} · ${config.lessonMode}`);
      initialized = true;
    });
    if (!initialized) await guarded(ctx, cleanup);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!recorder) return;
    summaryPending = false;
    summaryStartedAt = undefined;
    summaryPayload = undefined;
    restoreParent();
    if (recorder.config.lessonMode === "mcp-system")
      event.systemPromptOptions.sections.sovara = SYSTEM_INSTRUCTION;
    await guarded(ctx, async () => {
      exportFailed = false;
      await recorder!.start(
        event.messageType === "user"
          ? event.prompt
          : JSON.stringify(event.message.content),
      );
      process.env[PARENT_ENV] = JSON.stringify({
        url: recorder!.config.execUrl,
        projectName: recorder!.config.projectName,
        lessonMode: recorder!.config.lessonMode,
        scope: recorder!.scope!,
        sessionId: recorder!.sessionId,
      } satisfies Parent);
      status(
        ctx,
        `${recorder!.config.projectName} · ${recorder!.config.lessonMode} · recording`,
      );
    });
  });

  pi.on("context_with_system", async (event, ctx) => {
    const active = recorder;
    if (!active?.scope?.turnId || summaryPending) return;
    let messages = cleanMessages(event.messages);
    try {
      if (active.config.lessonMode === "automatic") {
        const query = retrievalSuffix.context(messages);
        const result = await active.retrieve(query.context, ctx.signal);
        const block = lessonBlock(result);
        active.retrieval = {
          ...active.retrieval,
          injected_lesson_ids: block.ids,
          injected_text: block.text,
          query_truncated: query.truncated,
          injection_truncated: block.truncated,
        };
        if (block.text)
          messages = [
            ...messages,
            referenceMessage(LESSON_MESSAGE, block.text),
          ];
      } else if (
        active.config.lessonMode === "mcp-reminder" &&
        needsReminder(messages)
      ) {
        messages = [...messages, referenceMessage(REMINDER_MESSAGE, REMINDER)];
      }
    } catch (error) {
      report(ctx, error);
    }
    active.context = structuredClone(messages);
    return { messages };
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (summaryPending) {
      summaryPayload = structuredClone(event.payload);
      return;
    }
    await guarded(ctx, async () => {
      await recorder?.beginGeneration(
        structuredClone(event.payload),
        ctx.model,
      );
    });
  });
  pi.on("message_update", (event) => {
    const active = recorder;
    if (
      active?.generation &&
      active.firstTokenAt === undefined &&
      ["text_delta", "thinking_delta", "toolcall_delta"].includes(
        event.assistantMessageEvent.type,
      )
    )
      active.firstTokenAt = Date.now();
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant")
      await guarded(ctx, async () => {
        await recorder?.endGeneration(event.message);
      });
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.beginTool(
        event.toolCallId,
        event.toolName,
        structuredClone(event.args),
        event.parentToolCallId,
      );
    });
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await guarded(ctx, async () => {
      await recorder?.endTool(
        event.toolCallId,
        structuredClone(event.result),
        event.isError,
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
        exportFailed ? "export incomplete" : "turn export acknowledged",
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
    if (!entry || !recorder) return;
    const active = recorder;
    const ownsTurn = !active.scope;
    await guarded(ctx, async () => {
      try {
        if (ownsTurn) await active.start(name);
        const step = await active.client.prepare(
          active.scope!,
          "pi.summary",
          "llm",
          {
            body: { model: ctx.model?.id },
            summary_kind: name,
            capture: "pi-summary-event",
            provider_payload: summaryPayload,
            input_unavailable: summaryPayload === undefined,
            lesson_mode: active.config.lessonMode,
          },
        );
        if (summaryStartedAt !== undefined) step.started = summaryStartedAt;
        await active.client.finish(
          step,
          withUsage(entry),
          (entry as { status?: string }).status === "error"
            ? "SummaryFailed"
            : undefined,
        );
      } finally {
        summaryStartedAt = undefined;
        summaryPayload = undefined;
        if (ownsTurn) await active.close();
      }
    });
  }
  pi.on("session_before_compact", () => {
    summaryPending = true;
    summaryStartedAt = Date.now();
    summaryPayload = undefined;
  });
  pi.on("session_before_tree", (event) => {
    summaryPending = event.preparation.userWantsSummary;
    summaryStartedAt = Date.now();
    summaryPayload = undefined;
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    summaryPending = false;
    await summary(
      "Compaction failed",
      { aborted: event.aborted, status: "error" },
      ctx,
    );
  });
  pi.on("session_compact", async (event, ctx) => {
    summaryPending = false;
    await summary("Compaction", event.compactionEntry, ctx);
  });
  pi.on("session_tree", async (event, ctx) => {
    summaryPending = false;
    await summary("Branch summary", event.summaryEntry, ctx);
  });
}
