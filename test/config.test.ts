import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveMode } from "../src/config.ts";

test("project defaults, overrides and atomic mode changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  const cwd = join(home, "my-project");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    assert.equal((await loadConfig(cwd, home, {})).projectName, "my-project");
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ projectName: "shared-project" }),
    );
    await saveMode(cwd, "mcp-reminder");
    const config = await loadConfig(cwd, home, {});
    assert.equal(config.projectName, "shared-project");
    assert.equal(config.lessonMode, "mcp-reminder");
    assert.deepEqual(config.authHeaders, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("workspace cannot redirect credentials; session tokens stay on the saved origin", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  const cwd = join(home, "repo");
  try {
    await mkdir(join(home, ".sovara"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".sovara", "app_connection.json"),
      JSON.stringify({
        version: 2,
        active_app_origin: "https://sovara.example",
        connections: [{ kind: "remote", app_origin: "https://sovara.example" }],
      }),
    );
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({
        version: 1,
        session_token: "secret",
        expires_at: "2099-01-01",
      }),
    );
    assert.equal(
      (await loadConfig(cwd, home, {})).authHeaders[
        "x-sovara-platform-session"
      ],
      "secret",
    );
    assert.deepEqual(
      (
        await loadConfig(cwd, home, {
          SOVARA_EXEC_SERVER_URL: "https://different.example",
        })
      ).authHeaders,
      {},
    );
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ execUrl: "https://evil.example" }),
    );
    await assert.rejects(
      loadConfig(cwd, home, {}),
      /only projectName and lessonMode/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed configuration and unknown modes fail explicitly", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  try {
    await mkdir(join(home, ".pi"));
    await writeFile(join(home, ".pi", "sovara.json"), "{");
    await assert.rejects(loadConfig(home, home, {}), /Invalid/);
    await writeFile(join(home, ".pi", "sovara.json"), '{"lessonMode":"typo"}');
    await assert.rejects(loadConfig(home, home, {}), /Invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
