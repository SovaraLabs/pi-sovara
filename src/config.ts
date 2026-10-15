import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const MODES = ["automatic", "mcp-reminder", "mcp-system"] as const;
export type LessonMode = (typeof MODES)[number];
export interface Config {
  projectName: string;
  lessonMode: LessonMode;
  execUrl: string;
  authHeaders: Record<string, string>;
}

export async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid or unreadable Sovara configuration");
  }
}

export function origin(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Sovara server URL must be an origin");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Invalid Sovara server origin");
  return url.origin;
}

export function mode(value: unknown): LessonMode {
  if (!MODES.includes(value as LessonMode))
    throw new Error("Invalid Sovara lesson mode");
  return value as LessonMode;
}

export async function loadConfig(
  cwd: string,
  home = homedir(),
  env = process.env,
  projectTrusted = true,
): Promise<Config> {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
  const global = (await readJson(join(agentDir, "sovara.json"))) ?? {};
  const local = projectTrusted
    ? ((await readJson(join(cwd, ".pi", "sovara.json"))) ?? {})
    : {};
  // A checked-in project file cannot redirect credentials to a different server.
  if (
    Object.keys(local).some(
      (key) => !["projectName", "lessonMode"].includes(key),
    )
  ) {
    throw new Error(
      "Project Sovara config supports only projectName and lessonMode",
    );
  }
  const projectName =
    local.projectName ?? global.projectName ?? basename(resolve(cwd));
  if (typeof projectName !== "string" || !projectName.trim())
    throw new Error("A project name is required");
  const connection = await readJson(
    join(home, ".sovara", "app_connection.json"),
  );
  let selected = "http://127.0.0.1:5960";
  let trustedOrigin: string | undefined;
  if (connection) {
    if (connection.version === 1 && connection.mode === "remote") {
      selected = trustedOrigin = origin(connection.remote_server_url);
    } else if (connection.version === 1 && connection.mode === "local") {
      trustedOrigin = selected;
    } else if (
      connection.version === 2 &&
      Array.isArray(connection.connections)
    ) {
      const active = origin(connection.active_app_origin);
      const entry = connection.connections.find(
        (c: any) => c.app_origin === active,
      );
      if (!entry || !["local", "remote"].includes(entry.kind))
        throw new Error("Invalid Sovara connection");
      selected = entry.kind === "local" ? selected : active;
      trustedOrigin = selected;
    } else throw new Error("Unsupported Sovara connection configuration");
  }
  const execUrl = origin(
    env.SOVARA_EXEC_SERVER_URL ?? global.execUrl ?? selected,
  );
  const lessonMode = mode(local.lessonMode ?? global.lessonMode ?? "automatic");
  const authHeaders: Record<string, string> = {};
  if (env.SOVARA_AGENT_TOKEN?.trim())
    authHeaders["x-sovara-agent-token"] = env.SOVARA_AGENT_TOKEN.trim();
  else if (execUrl === trustedOrigin) {
    const session = await readJson(join(home, ".sovara", "app_session.json"));
    if (
      session?.version === 1 &&
      typeof session.session_token === "string" &&
      typeof session.expires_at === "string" &&
      Date.parse(session.expires_at) > Date.now()
    ) {
      authHeaders["x-sovara-platform-session"] = session.session_token;
    }
  }
  return { projectName: projectName.trim(), lessonMode, execUrl, authHeaders };
}

export async function saveMode(
  cwd: string,
  lessonMode: LessonMode,
): Promise<void> {
  const directory = join(cwd, ".pi");
  const path = join(directory, "sovara.json");
  const config = (await readJson(path)) ?? {};
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ ...config, lessonMode }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(temporary, path);
}
