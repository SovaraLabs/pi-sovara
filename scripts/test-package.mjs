import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile),
  root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "sovara-pi-package-"));
let registry;
try {
  const sdk = JSON.parse(
    await readFile(join(root, ".validation/sdk/artifact.json"), "utf8"),
  );
  assert.equal(
    sdk.revision,
    (await readFile(join(root, "SDK_REVISION"), "utf8")).trim(),
  );
  const sdkTar = await readFile(sdk.tarball);
  assert.equal(createHash("sha256").update(sdkTar).digest("hex"), sdk.sha256);
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const sdkManifest = JSON.parse(
    await readFile(join(root, "node_modules/@sovara/sdk/package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies["@sovara/sdk"], sdkManifest.version);
  const [pack] = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
        { cwd: root },
      )
    ).stdout,
  );
  assert(
    pack.files.every(({ path }) =>
      /^(src\/|README.md$|LICENSE$|package.json$)/.test(path),
    ),
    "Unexpected published file",
  );
  assert(
    !pack.files.some(({ path }) => /^src\/(client|lessons)\.ts$/.test(path)),
    "Legacy recorder shipped",
  );
  const piTar = await readFile(join(temp, pack.filename));
  const home = join(temp, "home");
  await mkdir(home);
  const npmConfig = join(temp, "npmrc");
  await writeFile(npmConfig, "");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    npm_config_userconfig: npmConfig,
    npm_config_cache: join(temp, "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const consumer = join(temp, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "clean-pi-consumer",
      private: true,
      type: "module",
    }),
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      sdk.tarball,
      join(temp, pack.filename),
      "@earendil-works/pi-coding-agent@1.2.0",
    ],
    { cwd: consumer, env, maxBuffer: 8 * 1024 * 1024 },
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `import assert from 'node:assert/strict';\nimport {SovaraClient} from '@sovara/sdk';\nimport {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';\nimport {join} from 'node:path';\nimport {existsSync} from 'node:fs';\nassert.equal(existsSync(join(process.cwd(),'node_modules/@sovara/pi/node_modules/@sovara/sdk')),false,'Ordinary compatible install deduplicates core');\nconst agentDir=join(process.cwd(),'agent');\nconst runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models.json'),allowModelNetwork:false,refreshOnCreate:false});\nconst settings=SettingsManager.inMemory({defaultProjectTrust:'always'});\nconst loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir,settingsManager:settings,additionalExtensionPaths:[join(process.cwd(),'node_modules/@sovara/pi/src/index.ts')],noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});\nawait loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);assert(loader.getExtensions().extensions.some(e=>e.path.endsWith('@sovara/pi/src/index.ts')));assert.equal(typeof SovaraClient,'function');\nconst {session}=await createAgentSession({cwd:process.cwd(),agentDir,modelRuntime:runtime,resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(process.cwd()),tools:[]});\nawait session.bindExtensions({mode:'print'});await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();\nconsole.log('Clean paired tarball consumer loaded the public extension.');\n`,
  );
  const smoke = await exec(process.execPath, ["smoke.mjs"], {
    cwd: consumer,
    env,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(smoke.stdout);

  // Real Pi installation from a local registry containing only our two unpublished artifacts.
  // Other metadata is fetched anonymously from the public npm registry; no user npm config is used.
  const packages = new Map([
    [manifest.name, { manifest, tar: piTar, file: "pi.tgz" }],
    [sdkManifest.name, { manifest: sdkManifest, tar: sdkTar, file: "sdk.tgz" }],
  ]);
  registry = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      for (const value of packages.values())
        if (path === `/${value.file}`) {
          res.end(value.tar);
          return;
        }
      const entry = packages.get(path.slice(1));
      if (entry) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            name: entry.manifest.name,
            "dist-tags": { latest: entry.manifest.version },
            versions: {
              [entry.manifest.version]: {
                ...entry.manifest,
                dist: {
                  tarball: `${origin}/${entry.file}`,
                  integrity: `sha512-${createHash("sha512").update(entry.tar).digest("base64")}`,
                },
              },
            },
          }),
        );
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const upstream = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(path.slice(1))}`,
        { headers: { accept: "application/json" } },
      );
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${registry.address().port}`;
  const agentDir = join(temp, "pi-installed");
  const installEnv = {
    ...env,
    PI_CODING_AGENT_DIR: agentDir,
    npm_config_registry: origin,
  };
  for (const spec of [`npm:@sovara/pi@${manifest.version}`]) {
    const install = await exec(
      process.execPath,
      [
        join(
          consumer,
          "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        ),
        "install",
        spec,
      ],
      { cwd: temp, env: installEnv, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(install.stdout);
  }
  const installed = join(agentDir, "npm/node_modules/@sovara/pi");
  assert.equal(
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
    manifest.version,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(agentDir, "npm/node_modules/@sovara/sdk/package.json"),
        "utf8",
      ),
    ).version,
    sdkManifest.version,
  );
  assert(
    JSON.parse(
      await readFile(join(agentDir, "settings.json"), "utf8"),
    ).packages.includes(`npm:@sovara/pi@${manifest.version}`),
  );
  const tests = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "test/pi.test.ts",
      "test/summary.test.ts",
      "test/mcp.test.ts",
      "test/coexistence.test.ts",
      "test/session.test.ts",
      "test/handoff.test.ts",
      "test/cli-handoff.test.ts",
    ],
    {
      cwd: root,
      env: { ...installEnv, SOVARA_TEST_PACKAGE_ROOT: installed },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  process.stdout.write(tests.stdout);
  console.log(
    `Verified ordinary paired tarball install and Pi's native installer: @sovara/pi@${manifest.version}, @sovara/sdk@${sdkManifest.version} (${sdk.revision}).`,
  );
} finally {
  if (registry) {
    registry.closeAllConnections();
    await new Promise((resolve) => registry.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
