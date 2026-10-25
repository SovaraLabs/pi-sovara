import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ParentContext } from "@sovara/sdk";
import { loadConfig, type Config } from "./config.ts";
import { Recorder, createClient } from "./recorder.ts";
import { bindProviders } from "./provider.ts";
import { connectionDetails, explainError } from "./diagnostics.ts";
import { bindChildHandoff, PARENT_ENV } from "./child-handoff.ts";

export { exportParentContext } from "./child-handoff.ts";

const CONFIG_ENTRY = "sovara-config-v1";
const CHILD_ENTRY = "sovara-child-v1";

export default function sovara(pi: ExtensionAPI): void {
  const providers = bindProviders(pi);
  const originalParent = process.env[PARENT_ENV];
  const handoff = bindChildHandoff();
  let recorder: Recorder | undefined;
  let selectedConfig: Config | undefined;
  let lastError: string | undefined;
  let operationFailed = false;
  const signals = new Set<AbortSignal>();
  let summary:
    | {
        recorder: Recorder;
        signal: AbortSignal;
        timer?: NodeJS.Timeout;
        abort: () => void;
      }
    | undefined;
  let operations = Promise.resolve();
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
  const guarded = (ctx: ExtensionContext, work: () => Promise<void>) => {
    operations = operations.then(async () => {
      const active = recorder,
        activeSummary = summary?.recorder;
      try {
        await work();
      } catch (error) {
        report(ctx, error);
      } finally {
        for (const value of new Set([
          active,
          recorder,
          activeSummary,
          summary?.recorder,
        ]))
          for (const error of value?.takeExportErrors() ?? [])
            report(ctx, error);
      }
    });
    return operations;
  };
  async function closeSummary(cancelled = false): Promise<void> {
    const active = summary;
    summary = undefined;
    if (!active) return;
    clearInterval(active.timer);
    active.signal.removeEventListener("abort", active.abort);
    providers.unbind(active.signal);
    await active.recorder.close(cancelled);
  }
  async function closeTurn(cancelled = false): Promise<void> {
    handoff.closeTurn();
    for (const signal of signals) providers.unbind(signal);
    signals.clear();
    await recorder?.close(cancelled);
  }
  async function cleanup(): Promise<void> {
    await closeSummary(true);
    await closeTurn(true);
    recorder = undefined;
    providers.dispose();
    handoff.dispose();
  }

  pi.registerCommand("sovara", {
    description: "Show Sovara project and recording status",
    handler: async (_args, ctx) => {
      const lines = selectedConfig
        ? connectionDetails(selectedConfig, !!recorder?.recording)
        : ["Sovara configuration could not be loaded."];
      if (lastError) lines.push(`Last error: ${lastError}`);
      ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
    },
  });

  pi.on("session_start", (_event, ctx) =>
    guarded(ctx, async () => {
      await cleanup();
      operationFailed = false;
      selectedConfig = undefined;
      lastError = undefined;
      const config = await loadConfig(
        ctx.cwd,
        undefined,
        undefined,
        ctx.isProjectTrusted(),
      );
      selectedConfig = config;
      const entries = ctx.sessionManager.getEntries();
      const saved = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === CONFIG_ENTRY,
        );
      if (
        saved?.type === "custom" &&
        _event.reason !== "fork" &&
        _event.reason !== "new"
      ) {
        const data = saved.data as { projectName?: unknown };
        if (typeof data?.projectName !== "string" || !data.projectName)
          throw new Error("Invalid session binding");
        config.projectName = data.projectName;
      }
      // The SDK validates/copies the complete secret-bearing context before registration.
      const parent = originalParent
        ? (JSON.parse(originalParent) as ParentContext)
        : undefined;
      if (parent) {
        if (
          parent.url !== config.execUrl ||
          typeof parent.projectName !== "string"
        )
          throw new Error("Invalid parent binding");
        config.projectName = parent.projectName;
      }
      const child = [...entries]
        .reverse()
        .find(
          (entry) =>
            entry.type === "custom" && entry.customType === CHILD_ENTRY,
        );
      const data =
        child?.type === "custom"
          ? (child.data as {
              traceId?: string;
              parentTraceId?: string;
              url?: string;
              projectName?: string;
              sessionId?: string;
            })
          : undefined;
      const sessionId = ctx.sessionManager.getSessionId();
      const childTraceId =
        parent &&
        data &&
        data.parentTraceId === parent.traceId &&
        data.url === config.execUrl &&
        data.projectName === config.projectName &&
        data.sessionId === sessionId
          ? data.traceId
          : undefined;
      recorder = new Recorder(
        createClient(config),
        config,
        sessionId,
        parent,
        childTraceId,
        (traceId) =>
          pi.appendEntry(CHILD_ENTRY, {
            traceId,
            parentTraceId: parent!.traceId,
            url: config.execUrl,
            projectName: config.projectName,
            sessionId,
          }),
        ctx.sessionManager.getHeader()?.parentSession,
      );
      if (!saved || _event.reason === "fork" || _event.reason === "new")
        pi.appendEntry(CONFIG_ENTRY, { projectName: config.projectName });
      providers.install(ctx);
      handoff.bind(ctx.sessionManager);
      status(ctx, `${config.projectName} · ready`);
    }),
  );

  pi.on("before_agent_start", (event, ctx) =>
    guarded(ctx, async () => {
      if (!recorder) return;
      await closeSummary(true);
      await closeTurn(true);
      operationFailed = false;
      lastError = undefined;
      providers.install(ctx);
      await recorder.start(
        event.messageType === "user" ? event.prompt : event.message.content,
        ctx.signal,
      );
      handoff.activate(recorder.turn!);
      status(ctx, `${recorder.config.projectName} · recording`);
    }),
  );
  pi.on("context_with_system", (_event, ctx) => {
    if (!recorder?.turn || summary) return;
    providers.install(ctx);
    recorder.noteSignal(ctx.signal);
    if (ctx.signal) {
      signals.add(ctx.signal);
      providers.bind(ctx.signal, recorder.turn);
    }
    // Leave Pi's transcript untouched. SDK HTTP preparation injects temporary lessons.
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") recorder?.noteOutput(event.message);
  });
  pi.on("tool_execution_start", (event, ctx) =>
    guarded(ctx, async () => {
      await recorder?.beginTool(
        event.toolCallId,
        event.toolName,
        event.args,
        event.parentToolCallId,
      );
    }),
  );
  pi.on("tool_execution_end", (event, ctx) =>
    guarded(ctx, async () => {
      await recorder?.endTool(event.toolCallId, event.result, event.isError);
    }),
  );
  pi.on("agent_settled", (event, ctx) =>
    guarded(ctx, async () => {
      await closeTurn(event.aborted);
      if (recorder)
        status(
          ctx,
          operationFailed ? "export incomplete" : "turn export acknowledged",
        );
    }),
  );
  pi.on("session_shutdown", (_event, ctx) => guarded(ctx, cleanup));

  const startSummary = (
    name: string,
    signal: AbortSignal,
    ctx: ExtensionContext,
  ) =>
    guarded(ctx, async () => {
      await closeSummary(true);
      if (!recorder) return;
      const capture = recorder.summary();
      const abort = () => {
        void guarded(ctx, () => closeSummary(true));
      };
      summary = { recorder: capture, signal, abort };
      try {
        await capture.start(name, signal);
      } catch (error) {
        await closeSummary(true);
        throw error;
      }
      providers.install(ctx);
      providers.bind(signal, capture.turn!, (message) => {
        if (message) capture.noteOutput(message);
        else capture.noteFailure();
      });
      signal.addEventListener("abort", abort, { once: true });
      // Pi's public idle state includes branch-summary/compaction controllers.
      // Tree-summary failures have no terminal event; clean up after that controller clears.
      summary.timer = setInterval(() => {
        if (summary?.recorder !== capture) return;
        if (ctx.isIdle())
          void guarded(ctx, async () => {
            if (summary?.recorder !== capture) return;
            capture.noteFailure();
            await closeSummary(signal.aborted);
          });
      }, 50);
      summary.timer.unref();
    });
  pi.on("session_before_compact", (event, ctx) =>
    startSummary("Compaction", event.signal, ctx),
  );
  pi.on("session_before_tree", (event, ctx) =>
    event.preparation.userWantsSummary
      ? startSummary("Branch summary", event.signal, ctx)
      : undefined,
  );
  pi.on("session_compact_failed", (event, ctx) =>
    guarded(ctx, async () => {
      summary?.recorder.noteFailure();
      await closeSummary(event.aborted);
    }),
  );
  pi.on("session_compact", (_event, ctx) => guarded(ctx, () => closeSummary()));
  pi.on("session_tree", (_event, ctx) => guarded(ctx, () => closeSummary()));
}
