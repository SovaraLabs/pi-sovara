import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { SovaraClient }: typeof import("../src/client.ts") = await import(
  pathToFileURL(
    resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/client.ts"),
  ).href
);

const config = {
  projectName: "test",
  execUrl: "http://127.0.0.1:5960",
  authHeaders: {},
  autoStartLocal: true,
  connectionKind: "local" as const,
  authentication: "none" as const,
};
const metadata = {
  compatibility: { component: "exec-server", contracts: { "runner-api": [4] } },
};
const refused = () =>
  new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });

test("a refused managed local connection starts once and renegotiates compatibility", async () => {
  let attempts = 0;
  const starts: string[] = [];
  const client = new SovaraClient(
    config,
    async () => {
      if (attempts++ === 0) throw refused();
      return Response.json(metadata);
    },
    async (url) => {
      starts.push(url);
    },
  );
  await client.connect();
  assert.deepEqual(starts, [config.execUrl]);
  assert.equal(attempts, 2);
});

test("a reachable local service never invokes the CLI", async () => {
  const client = new SovaraClient(
    config,
    async () => Response.json(metadata),
    async () => {
      assert.fail("must not start a healthy server");
    },
  );
  await client.connect();
});

test("remote or explicitly configured endpoints never start a local process", async () => {
  for (const execUrl of ["https://remote.example", "http://127.0.0.1:5970"]) {
    const client = new SovaraClient(
      { ...config, execUrl, autoStartLocal: false },
      async () => {
        throw refused();
      },
      async () => {
        assert.fail("must not start a remote or explicitly configured server");
      },
    );
    await assert.rejects(client.connect(), /fetch failed/);
  }
});

test("HTTP, malformed, incompatible and timeout failures do not trigger startup", async () => {
  for (const fetcher of [
    async () => Response.json({}, { status: 401 }),
    async () => Response.json({}, { status: 503 }),
    async () => new Response("invalid json"),
    async () => Response.json({}),
    async () =>
      Response.json({
        compatibility: {
          component: "exec-server",
          contracts: { "runner-api": [5] },
        },
      }),
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ]) {
    const client = new SovaraClient(config, fetcher, async () => {
      assert.fail("must not start");
    });
    await assert.rejects(client.connect());
  }
});

test("startup errors are safe and cannot enable business requests", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const client = new SovaraClient(
      config,
      async () => {
        throw refused();
      },
      async () => {
        throw Object.assign(new Error("PRIVATE CLI OUTPUT"), { code });
      },
    );
    await assert.rejects(
      client.connect(),
      code === "ENOENT" ? /cli_not_found/ : /exec_server_start_failed/,
    );
    await assert.rejects(client.register("test", "/repo"), /not_connected/);
  }
});

test("post-start health is still required and startup is never retried in a loop", async () => {
  for (const postStart of [
    async () => {
      throw refused();
    },
    async () =>
      Response.json({
        compatibility: {
          component: "exec-server",
          contracts: { "runner-api": [5] },
        },
      }),
  ]) {
    let attempts = 0;
    let starts = 0;
    const client = new SovaraClient(
      config,
      async () => {
        if (attempts++ === 0) throw refused();
        return postStart();
      },
      async () => {
        starts++;
      },
    );
    await assert.rejects(client.connect());
    assert.equal(starts, 1);
    await assert.rejects(client.register("test", "/repo"), /not_connected/);
  }
});

test(
  "real CLI invocation pins the selected URL without a shell",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cli-start-"));
    const previousPath = process.env.PATH;
    const output = join(dir, "invocation.json");
    try {
      await writeFile(
        join(dir, "sovara"),
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), url: process.env.SOVARA_EXEC_SERVER_URL }));\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
      let attempts = 0;
      const client = new SovaraClient(config, async () => {
        if (attempts++ === 0) throw refused();
        return Response.json(metadata);
      });
      await client.connect();
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
        args: ["exec-server", "start"],
        url: config.execUrl,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
