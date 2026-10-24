import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const revision = (await readFile(join(root, "SDK_REVISION"), "utf8")).trim();
if (!/^[a-f0-9]{40}$/.test(revision))
  throw Error("SDK_REVISION must contain an exact public source commit");
const source = await mkdtemp(join(tmpdir(), "pi-sdk-source-"));
const output = join(root, ".validation/sdk");
await mkdir(output, { recursive: true });
const run = (command, args, cwd = source) =>
  exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
try {
  await run("git", ["init", "--quiet"]);
  await run("git", [
    "remote",
    "add",
    "origin",
    "https://github.com/SovaraLabs/typescript-sdk.git",
  ]);
  await run("git", ["fetch", "--quiet", "--depth=1", "origin", revision]);
  await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== revision)
    throw Error("SDK source revision mismatch");
  await run("npm", ["ci", "--ignore-scripts"]);
  await run("npm", ["run", "build"]);
  const manifest = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  );
  const own = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    manifest.name !== "@sovara/sdk" ||
    manifest.version !== own.dependencies[manifest.name]
  )
    throw Error("SDK dependency version mismatch");
  const [pack] = JSON.parse(
    (
      await run("npm", [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        output,
      ])
    ).stdout,
  );
  const tarball = join(output, pack.filename);
  const sha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  // Source-preview bootstrap only: install the pinned source build in place of
  // the not-yet-published registry artifact, keeping all other lock entries.
  const lockPath = join(root, "package-lock.json"),
    originalLock = await readFile(lockPath, "utf8");
  const lock = JSON.parse(originalLock),
    entry = lock.packages["node_modules/@sovara/sdk"];
  if (!entry || entry.version !== manifest.version)
    throw Error("SDK lock version mismatch");
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  // npm's gzip bytes vary across platform/zlib builds even when the unpacked
  // archive is identical. The exact public source commit and its npm lockfile
  // identify this preview build; npm ci verifies the local artifact's integrity.
  entry.resolved = `file:${tarball}`;
  entry.integrity = integrity;
  try {
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
    await run("npm", ["ci", "--ignore-scripts"], root);
  } finally {
    await writeFile(lockPath, originalLock);
  }
  await writeFile(
    join(output, "artifact.json"),
    JSON.stringify(
      { revision, sha256, tarball, version: manifest.version },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Installed @sovara/sdk@${manifest.version} from public source ${revision}; sha256 ${sha256}`,
  );
} finally {
  await rm(source, { recursive: true, force: true });
}
