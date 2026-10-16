import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface Config {
  projectName: string;
  execUrl: string;
  /** Derived from connection provenance, never a workspace setting. */
  autoStartLocal: boolean;
  connectionKind: "local" | "remote" | "override";
  authentication: "agent-token" | "session" | "expired" | "none";
  authHeaders: Record<string, string>;
}

export class ConfigError extends Error {}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new ConfigError();
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError("Invalid or unreadable Sovara configuration");
  }
}

function origin(value: unknown): string {
  if (typeof value !== "string")
    throw new ConfigError("Sovara server URL must be an origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("Invalid Sovara server origin");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ConfigError("Invalid Sovara server origin");
  return url.origin;
}

export async function loadConfig(
  cwd: string,
  home = homedir(),
  env = process.env,
  projectTrusted = true,
): Promise<Config> {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  const global = (await readJson(join(agentDir, "sovara.json"))) ?? {};
  if (
    Object.keys(global).some((key) => !["projectName", "execUrl"].includes(key))
  )
    throw new ConfigError(
      "User Sovara config supports only projectName and execUrl",
    );
  const local = projectTrusted
    ? ((await readJson(join(cwd, ".pi", "sovara.json"))) ?? {})
    : {};
  // A checked-in project file cannot redirect credentials to a different server.
  if (Object.keys(local).some((key) => !["projectName"].includes(key))) {
    throw new ConfigError("Project Sovara config supports only projectName");
  }
  const projectName =
    local.projectName ?? global.projectName ?? basename(resolve(cwd));
  if (typeof projectName !== "string" || !projectName.trim())
    throw new ConfigError("A project name is required");
  const connection = await readJson(
    join(home, ".sovara", "app_connection.json"),
  );
  let selected = "http://127.0.0.1:5960";
  let trustedOrigin: string | undefined;
  let localConnection = true;
  if (connection) {
    if (connection.version === 1 && connection.mode === "remote") {
      selected = trustedOrigin = origin(connection.remote_server_url);
      localConnection = false;
    } else if (connection.version === 1 && connection.mode === "local") {
      trustedOrigin = selected;
    } else if (
      connection.version === 2 &&
      Array.isArray(connection.connections)
    ) {
      const active = origin(connection.active_app_origin);
      const entry = connection.connections.find(
        (c: unknown): c is Record<string, unknown> =>
          !!c &&
          typeof c === "object" &&
          "app_origin" in c &&
          c.app_origin === active,
      );
      if (!entry || (entry.kind !== "local" && entry.kind !== "remote"))
        throw new ConfigError("Invalid Sovara connection");
      localConnection = entry.kind === "local";
      selected = localConnection ? selected : active;
      trustedOrigin = selected;
    } else throw new ConfigError("Unsupported Sovara connection configuration");
  }
  const execUrl = origin(
    env.SOVARA_EXEC_SERVER_URL ?? global.execUrl ?? selected,
  );
  const authHeaders: Record<string, string> = {};
  let authentication: Config["authentication"] = "none";
  if (env.SOVARA_AGENT_TOKEN?.trim()) {
    authHeaders["x-sovara-agent-token"] = env.SOVARA_AGENT_TOKEN.trim();
    authentication = "agent-token";
  } else if (execUrl === trustedOrigin) {
    const session = await readJson(join(home, ".sovara", "app_session.json"));
    if (
      session?.version === 1 &&
      typeof session.session_token === "string" &&
      typeof session.expires_at === "string"
    ) {
      if (Date.parse(session.expires_at) > Date.now()) {
        authHeaders["x-sovara-platform-session"] = session.session_token;
        authentication = "session";
      } else authentication = "expired";
    }
  }
  const override =
    env.SOVARA_EXEC_SERVER_URL !== undefined || global.execUrl !== undefined;
  return {
    connectionKind: override
      ? "override"
      : localConnection
        ? "local"
        : "remote",
    authentication,
    projectName: projectName.trim(),
    execUrl,
    authHeaders,
    autoStartLocal: localConnection && !override,
  };
}
