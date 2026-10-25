import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("Pi selects local/remote/override connections while leaving credentials to the SDK", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-config-"));
  try {
    await mkdir(join(home, ".sovara"));
    await mkdir(join(home, ".pi"));
    let config = await loadConfig(home, home, {});
    assert.equal(config.autoStartLocal, true);
    assert.equal(config.execUrl, "http://127.0.0.1:5960");
    await writeFile(
      join(home, ".sovara/app_session.json"),
      "malformed credentials must not be read by Pi",
    );
    for (const connection of [
      {
        version: 1,
        mode: "remote",
        remote_server_url: "https://remote.example",
      },
      {
        version: 2,
        active_app_origin: "https://remote.example",
        connections: [{ kind: "remote", app_origin: "https://remote.example" }],
      },
    ]) {
      await writeFile(
        join(home, ".sovara/app_connection.json"),
        JSON.stringify(connection),
      );
      config = await loadConfig(home, home, {});
      assert.equal(config.execUrl, "https://remote.example");
      assert.equal(config.autoStartLocal, false);
      assert.equal(config.authentication, "sdk-managed");
      assert(!("authHeaders" in config));
    }
    for (const env of [
      { SOVARA_EXEC_SERVER_URL: "http://127.0.0.1:5960" },
      { SOVARA_EXEC_SERVER_PORT: "5970" },
    ]) {
      config = await loadConfig(home, home, env);
      assert.equal(config.autoStartLocal, false);
      assert.equal(config.connectionKind, "override");
    }
    assert.equal(
      (await loadConfig(home, home, { SOVARA_AGENT_TOKEN: "CONTROLLED" }))
        .authentication,
      "agent-token",
    );
    for (const bad of ["0", "-1", "65536", "bad"])
      await assert.rejects(
        loadConfig(home, home, { SOVARA_EXEC_SERVER_PORT: bad }),
        /Invalid/,
      );
    await writeFile(
      join(home, ".pi/sovara.json"),
      JSON.stringify({ execUrl: "https://untrusted.example" }),
    );
    await assert.rejects(loadConfig(home, home, {}), /only projectName/);
    assert.equal(
      (await loadConfig(home, home, {}, false)).execUrl,
      "https://remote.example",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("project binding and strict configuration are preserved", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-project-"));
  try {
    await mkdir(join(home, ".pi"));
    await mkdir(join(home, "agent"));
    const env = { PI_CODING_AGENT_DIR: join(home, "agent") };
    await writeFile(
      join(home, "agent/sovara.json"),
      JSON.stringify({
        projectName: "global",
        execUrl: "https://gateway.example",
      }),
    );
    await writeFile(
      join(home, ".pi/sovara.json"),
      JSON.stringify({ projectName: "local" }),
    );
    assert.equal((await loadConfig(home, home, env)).projectName, "local");
    assert.equal(
      (await loadConfig(home, home, env, false)).projectName,
      "global",
    );
    for (const url of [
      "https://user:secret@remote.example",
      "https://remote.example/path",
      "https://remote.example?q=secret",
      "https://remote.example#secret",
      " https://remote.example",
    ])
      await assert.rejects(
        loadConfig(home, home, { ...env, SOVARA_EXEC_SERVER_URL: url }),
      );
    await writeFile(join(home, ".pi/sovara.json"), "{");
    await assert.rejects(loadConfig(home, home, env), /Invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
