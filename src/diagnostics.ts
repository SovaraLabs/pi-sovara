import { CompatibilityError } from "@sovara/sdk";
import { ConfigError, type Config } from "./config.ts";

/** Display only known messages; server bodies and provider credentials stay private. */
export function explainError(error: unknown, config?: Config): string {
  if (error instanceof ConfigError)
    return `${error.message}. Check your Sovara connection and .pi/sovara.json settings, then /reload.`;
  if (error instanceof CompatibilityError)
    return "This Sovara server lacks a required SDK capability. Update Sovara and the extension, then /reload.";
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  if (status === 401)
    return config?.authentication === "agent-token"
      ? "Sovara rejected the agent token. Check SOVARA_AGENT_TOKEN, then /reload."
      : "Sovara sign-in is missing or expired. Sign in to the selected server in Sovara, then /reload.";
  if (status === 403)
    return "Sovara denied access. Check access to this project, then /reload.";
  if (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    return "Sovara operation cancelled or timed out; recording may be incomplete.";
  return config?.autoStartLocal
    ? "Sovara operation failed. Check the local server with `sovara exec-server start`, then /reload."
    : "Sovara operation failed. Check the selected server, network or VPN, then /reload.";
}

export function connectionDetails(config: Config, active: boolean): string[] {
  return [
    `Server: ${config.execUrl}`,
    `Mode: ${config.connectionKind}`,
    `Project: ${config.projectName}`,
    `Recording: ${active ? "active" : "idle"}`,
    `Authentication: ${config.authentication === "agent-token" ? "agent token configured" : "managed by the Sovara SDK"}`,
  ];
}
