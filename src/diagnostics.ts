import { SovaraError } from "./client.ts";
import { ConfigError, type Config } from "./config.ts";

/** Only local, known messages are displayed; remote bodies and CLI stderr stay private. */
export function explainError(error: unknown, config?: Config): string {
  if (error instanceof ConfigError)
    return `${error.message}. Check your Sovara connection and .pi/sovara.json settings, then /reload.`;
  if (error instanceof SovaraError) {
    if (error.status === 401)
      return config?.authentication === "agent-token"
        ? "Sovara rejected the agent token. Check SOVARA_AGENT_TOKEN, then /reload."
        : "Sovara sign-in is missing or expired. Sign in to the selected server in Sovara, then /reload.";
    if (error.status === 403)
      return "Sovara denied access. Check that your account or agent token can access this project, then /reload.";
    if (error.code === "cli_not_found")
      return "Sovara CLI was not found on PATH. Install it from https://docs.sovara-labs.com/cli/install, then restart Pi.";
    if (error.code === "exec_server_start_failed")
      return "The local Sovara server could not start. Run `sovara exec-server start` for details, then /reload.";
    if (error.code === "incompatible_runner_api")
      return "This Sovara server does not support runner-api 4. Install compatible Sovara/Pi extension versions, then /reload.";
    return `${error.message}. Check the selected Sovara server, then /reload.`;
  }
  if (error instanceof Error && error.name === "AbortError")
    return "Sovara operation cancelled; recording or retrieval may be incomplete.";
  if (error instanceof Error && error.name === "TimeoutError")
    return "Sovara did not respond in time. Check the selected server, then /reload.";
  if (error instanceof TypeError && "cause" in error)
    return config?.autoStartLocal
      ? "Cannot connect to the local Sovara server. Run `sovara exec-server start` for details, then /reload."
      : "Cannot connect to the selected Sovara server. Check its URL, network or VPN, then /reload.";
  return "Sovara operation failed. Check your configuration and server, then /reload.";
}

export function connectionDetails(config: Config, ready: boolean): string[] {
  const authentication = {
    "agent-token": "agent token configured",
    session: "saved sign-in session",
    expired: "saved session expired — sign in to Sovara, then /reload",
    none: "no credentials configured (local servers may allow this)",
  }[config.authentication];
  return [
    `Server: ${config.execUrl}`,
    `Mode: ${config.connectionKind === "override" ? "explicit URL override" : config.connectionKind}`,
    `Project: ${config.projectName}`,
    `Connection: ${ready ? "server reachable" : "unavailable"}`,
    `Authentication: ${authentication}`,
  ];
}
