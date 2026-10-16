import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fixtureServer } from "./helpers.ts";
const { loadConfig }: typeof import("../src/config.ts") = await import(
  pathToFileURL(
    resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/config.ts"),
  ).href
);

test("saved remote session authenticates recording at its selected gateway", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-remote-auth-"));
  const server = await fixtureServer();
  const { SovaraClient }: typeof import("../src/client.ts") = await import(
    pathToFileURL(
      resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/client.ts"),
    ).href
  );
  try {
    await mkdir(join(home, ".sovara"));
    await writeFile(
      join(home, ".sovara/app_connection.json"),
      JSON.stringify({
        version: 2,
        active_app_origin: server.config.execUrl,
        connections: [{ kind: "remote", app_origin: server.config.execUrl }],
      }),
    );
    await writeFile(
      join(home, ".sovara/app_session.json"),
      JSON.stringify({
        version: 1,
        session_token: "synthetic-session",
        expires_at: "2099-01-01",
      }),
    );
    const config = await loadConfig(home, home, {});
    assert.equal(config.connectionKind, "remote");
    assert.equal(config.authentication, "session");
    assert.equal(config.autoStartLocal, false);
    const client = new SovaraClient(config, fetch, async () =>
      assert.fail("remote must not start local CLI"),
    );
    await client.connect();
    await client.register("remote-fixture", home);
    assert.equal(
      server.calls.find((call) => call.path === "/runner/register")?.headers[
        "x-sovara-platform-session"
      ],
      "synthetic-session",
    );
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("project defaults and overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  const cwd = join(home, "my-project");
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    assert.equal((await loadConfig(cwd, home, {})).projectName, "my-project");
    await writeFile(
      join(cwd, ".pi", "sovara.json"),
      JSON.stringify({ projectName: "shared-project" }),
    );
    const config = await loadConfig(cwd, home, {});
    assert.equal(config.projectName, "shared-project");
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
    await assert.rejects(loadConfig(cwd, home, {}), /only projectName/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed configuration and unsupported keys fail explicitly", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  try {
    await mkdir(join(home, ".pi"));
    await writeFile(join(home, ".pi", "sovara.json"), "{");
    await assert.rejects(loadConfig(home, home, {}), /Invalid/);
    await writeFile(join(home, ".pi", "sovara.json"), '{"unknown":true}');
    await assert.rejects(loadConfig(home, home, {}), /only projectName/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("automatic startup follows connection provenance, not just a loopback URL", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-startup-config-"));
  try {
    await mkdir(join(home, ".sovara"));
    await mkdir(join(home, "agent"));
    const env = { PI_CODING_AGENT_DIR: join(home, "agent") };
    assert.equal((await loadConfig(home, home, env)).autoStartLocal, true);
    for (const [connection, expected] of [
      [{ version: 1, mode: "local" }, true],
      [
        {
          version: 1,
          mode: "remote",
          remote_server_url: "https://remote.example",
        },
        false,
      ],
      [
        {
          version: 2,
          active_app_origin: "http://127.0.0.1:5959",
          connections: [{ kind: "local", app_origin: "http://127.0.0.1:5959" }],
        },
        true,
      ],
      [
        {
          version: 2,
          active_app_origin: "http://127.0.0.1:5970",
          connections: [
            { kind: "remote", app_origin: "http://127.0.0.1:5970" },
          ],
        },
        false,
      ],
    ] as const) {
      await writeFile(
        join(home, ".sovara", "app_connection.json"),
        JSON.stringify(connection),
      );
      assert.equal(
        (await loadConfig(home, home, env)).autoStartLocal,
        expected,
      );
    }
    await writeFile(
      join(home, ".sovara", "app_connection.json"),
      JSON.stringify({ version: 1, mode: "local" }),
    );
    assert.equal(
      (
        await loadConfig(home, home, {
          ...env,
          SOVARA_EXEC_SERVER_URL: "http://127.0.0.1:5960",
        })
      ).autoStartLocal,
      false,
    );
    await writeFile(
      join(home, "agent", "sovara.json"),
      JSON.stringify({ execUrl: "http://127.0.0.1:5960" }),
    );
    assert.equal((await loadConfig(home, home, env)).autoStartLocal, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connection diagnostics distinguish saved remote, expired session and explicit token", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-diagnostics-config-"));
  try {
    await mkdir(join(home, ".sovara"));
    await writeFile(
      join(home, ".sovara", "app_connection.json"),
      JSON.stringify({
        version: 1,
        mode: "remote",
        remote_server_url: "https://remote.example",
      }),
    );
    await writeFile(
      join(home, ".sovara", "app_session.json"),
      JSON.stringify({
        version: 1,
        session_token: "private-expired-session",
        expires_at: "2000-01-01",
      }),
    );
    const expired = await loadConfig(home, home, {});
    assert.equal(expired.connectionKind, "remote");
    assert.equal(expired.authentication, "expired");
    assert.deepEqual(expired.authHeaders, {});
    const token = await loadConfig(home, home, {
      SOVARA_AGENT_TOKEN: "private-agent-token",
    });
    assert.equal(token.authentication, "agent-token");
    assert.equal(token.connectionKind, "remote");
    const override = await loadConfig(home, home, {
      SOVARA_EXEC_SERVER_URL: "http://127.0.0.1:5970",
    });
    assert.equal(override.connectionKind, "override");
    assert.equal(override.authentication, "none");
    await assert.rejects(
      loadConfig(home, home, {
        SOVARA_EXEC_SERVER_URL: "invalid-private-origin",
      }),
      /Invalid Sovara server origin/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
