import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { completion, fixtureServer } from "./helpers.ts";

const exec = promisify(execFile);
test("bundled Pi CLI supports explicit handoff imported by a separate trusted extension", async () => {
  const server = await fixtureServer(),
    cwd = await mkdtemp(join(tmpdir(), "pi-cli-parent-"));
  const result = join(cwd, "result.json"),
    extension = join(cwd, "fixture.ts");
  let requests = 0;
  server.provider((_body, response) =>
    completion(
      response,
      "Done",
      requests++ === 0 ? { name: "spawn_child", arguments: {} } : undefined,
    ),
  );
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi/sovara.json"),
      JSON.stringify({ projectName: "cli-parent" }),
    );
    await mkdir(join(cwd, "node_modules/@sovara"), { recursive: true });
    await symlink(resolve(process.env.SOVARA_TEST_HELPER_PACKAGE_ROOT ?? process.env.SOVARA_TEST_PACKAGE_ROOT ?? "."), join(cwd, "node_modules/@sovara/pi"), "dir");
    await writeFile(
      extension,
      `import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {writeFile} from 'node:fs/promises';import {Type} from 'typebox';import {exportParentContext} from '@sovara/pi';
const exec=promisify(execFile);
export default pi=>{
pi.registerProvider('fixture',{api:'openai-completions',apiKey:'CONTROLLED_CANARY',baseUrl:${JSON.stringify(server.url + "/v1")},models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:4096}]});
pi.registerTool({name:'spawn_child',label:'Spawn',description:'Controlled child',parameters:Type.Object({}),async execute(_id,_args,signal,_update,ctx){
const {stdout}=await exec(process.execPath,['-e',"const c=JSON.parse(process.env.SOVARA_PI_PARENT||'null');console.log(JSON.stringify(c&&{traceId:c.traceId,turnId:c.turnId,projectName:c.projectName,hasToken:!!c.traceWriteToken}))"],{signal,env:{...process.env,SOVARA_PI_PARENT:JSON.stringify(exportParentContext(ctx))}});
await writeFile(${JSON.stringify(result)},JSON.stringify({parent:JSON.parse(stdout),processUnchanged:process.env.SOVARA_PI_PARENT===undefined}));
return {content:[{type:'text',text:'Done'}],details:{}};}});};`,
    );
    const command = exec(
      process.execPath,
      [
        resolve(
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "--offline",
        "--approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "-e",
        extension,
        "-e",
        resolve(process.env.SOVARA_TEST_PACKAGE_ROOT ?? ".", "src/index.ts"),
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "--tools",
        "spawn_child",
        "-p",
        "Launch the controlled child once.",
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          PI_CODING_AGENT_DIR: join(cwd, "agent"),
          SOVARA_EXEC_SERVER_URL: server.url,
        },
        timeout: 30000,
      },
    );
    command.child.stdin?.end();
    const output = await command;
    assert.doesNotMatch(output.stderr, /sovara-pi|Failed to load extension/);
    const observed = JSON.parse(await readFile(result, "utf8"));
    assert.equal(observed.parent.projectName, "cli-parent");
    assert.equal(observed.parent.hasToken, true);
    assert(observed.parent.turnId);
    assert.equal(observed.processUnchanged, true);
    assert.equal(
      observed.parent.traceId,
      server.calls.find((c) => c.path === "/runner/register")!.body.trace_id,
    );
    assert.equal(requests, 2);
    assert.equal(
      server.calls.filter((c) => c.path.endsWith("/prepare")).length,
      3,
    );
    assert.equal(
      server.calls.filter((c) => c.path.endsWith("/finalize")).length,
      3,
    );
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
