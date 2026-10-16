import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "sovara-package-"));
let registry;
try {
  const { stdout } = await exec(
    "npm",
    ["pack", "--json", "--pack-destination", temp],
    { cwd: root },
  );
  const [pack] = JSON.parse(stdout);
  assert.ok(
    pack.files.every(({ path }) =>
      /^(src\/|README.md$|LICENSE$|package.json$)/.test(path),
    ),
    "unexpected published file",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const tarball = await readFile(join(temp, pack.filename));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  // Exercise Pi's real npm installer without publishing or using the user's npm credentials.
  registry = createServer((req, res) => {
    if (req.url === "/package.tgz") {
      res.end(tarball);
    } else if (decodeURIComponent(req.url).split("?")[0] === "/@sovara/pi") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...manifest,
              dist: { tarball: `${origin}/package.tgz`, integrity },
            },
          },
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => registry.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${registry.address().port}`;
  const agentDir = join(temp, "agent");
  const npmConfig = join(temp, "npmrc");
  await writeFile(npmConfig, "");
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    npm_config_userconfig: npmConfig,
    npm_config_registry: origin,
    npm_config_cache: join(temp, "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const result = await exec(
    process.execPath,
    [
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "install",
      `npm:@sovara/pi@${manifest.version}`,
    ],
    { cwd: temp, env },
  );
  process.stdout.write(result.stdout);
  const installed = join(agentDir, "npm/node_modules/@sovara/pi");
  assert.equal(
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
    manifest.version,
  );
  const settings = JSON.parse(
    await readFile(join(agentDir, "settings.json"), "utf8"),
  );
  assert.ok(settings.packages.includes(`npm:@sovara/pi@${manifest.version}`));
  const tests = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "test/pi.test.ts",
      "test/config.test.ts",
      "test/startup.test.ts",
    ],
    {
      cwd: root,
      env: { ...env, SOVARA_TEST_PACKAGE_ROOT: installed },
      maxBuffer: 1024 * 1024,
    },
  );
  process.stdout.write(tests.stdout);
  console.log(
    `Verified @sovara/pi@${manifest.version} installed by Pi from its npm tarball.`,
  );
} finally {
  if (registry) await new Promise((done) => registry.close(done));
  await rm(temp, { recursive: true, force: true });
}
