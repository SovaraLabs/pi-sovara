# Sovara for Pi

Sovara adds your team's lessons to Pi's actual provider requests and records model calls, tools, and MCP activity. Lessons are temporary: they never become part of Pi's saved conversation.

## Install

This branch is a source preview. Its SDK dependency must be published before this version of the extension is released; no registry release is implied by this PR. The source-preview commands below work with the exact public SDK revision without publishing either package.

After the coordinated release, use Node 24.22.1 or newer and Pi 1.2.0:

```sh
pi install npm:@sovara/pi
pi
```

The extension installs its SDK runtime dependency. Open [Sovara Desktop](https://docs.sovara-labs.com/get-started/installation), complete setup, and select your local or remote connection. Send a message in Pi, then open the matching project in Sovara. Provider API keys, subscription sign-in, custom provider configuration, and gateways remain managed by Pi.

## Configure

The project defaults to the folder where Pi starts. A trusted project's `.pi/sovara.json` can choose a project name:

```json
{ "projectName": "my-project" }
```

User defaults live in `~/.pi/agent/sovara.json` (or `$PI_CODING_AGENT_DIR/sovara.json`). That file may contain `projectName` and `execUrl`. A project file cannot redirect the server or supply credentials.

Connection selection is, in order: `SOVARA_EXEC_SERVER_URL`, the user `execUrl`, `SOVARA_EXEC_SERVER_PORT`, then the connection selected in Sovara Desktop. With the default managed local connection, the SDK may start the local exec server when it is not running. Explicit URLs and ports never start a local service. Server URLs must be HTTP(S) origins without paths, query parameters, or embedded credentials.

The SDK owns Sovara authentication. It uses `SOVARA_AGENT_TOKEN` when supplied, otherwise a valid desktop session bound to the selected server. Pi does not copy desktop tokens into its configuration or session history.

- `/sovara` shows the selected connection, project, recording state, and safe recovery guidance.
- `/reload` applies connection changes and reinstalls the provider wrapper.
- `pi update` updates installed packages after release.
- `pi remove npm:@sovara/pi` removes the extension.

## Recording behavior

The SDK prepares each supported native provider HTTP request once, sends the prepared request through the original transport, and finalizes the observed result. Ordinary tools and Pi's MCP tools have one owner: Pi's tool lifecycle. There is no separate Pi model envelope or second lesson retrieval call. Server failures do not replay provider requests; `/sovara` reports incomplete export.

Each user run has its own recording and logical turn in the durable Pi session trace. Resumed sessions retain their project binding. New or forked sessions receive their own binding. Native branch summaries and compaction run in separate logical turns, including their retries and cancellation. A summary during an active run shares that recording without closing the ordinary turn.

For a child process launched from an active Pi run, `SOVARA_PI_PARENT` carries the SDK's versioned parent context in that child's environment. The extension never publishes a live turn credential into the parent process environment. It contains a scoped write credential: pass it only to the intended child and do not log it. The child creates or reattaches only its own trace, keeps the original parent/project/lesson scope, and cannot close the parent through this API. Only the nonsecret child trace mapping is saved in Pi's session. The parent must be active when a child is created or reattached. Child attachment requires a server advertising `child_attachment_scope`.

Child handoff is verified with Pi **1.2.0**. Pi has no extension hook around tool execution, so a small compatibility wrapper scopes the public `AgentSession.prompt` and `sendCustomMessage` entry points and copies the active turn context at subprocess launch. Native `spawn`, `exec`, `execFile`, and `fork` are covered, including references captured before extension loading. `spawnSync`, `execSync`, and `execFileSync` are covered through their module exports and ESM named imports. A synchronous function copied into a local variable before the extension loads cannot be replaced through public Node APIs and does not receive automatic handoff. Explicit `options.env` is always caller-owned: include an intended parent context there yourself, or supply an environment without that field to disable automatic handoff. Omitting `options.env` enables the automatic invocation context. Outside-session calls keep their original environment. Reload and settlement revoke the invocation context; delayed work cannot borrow a later turn. The incoming startup variable remains unchanged and is used only to initialize a child session.

Pi's built-in Bash creates its own environment. For sessions initialized while
the extension is loaded, a compatibility observer records the native executor
when Pi publishes its tools through the public `agent.state.tools` property.
The extension delegates that exact executor and supplies the current parent at
its subprocess launch, including when Pi itself is a child. It keeps the original
definition, schemas, renderers, captured shell settings, output handling and
cancellation. Shell settings take effect on native reload. The same boundary is
wired for PowerShell; actual Windows/PowerShell execution is untested.

Custom extension tools, SDK base-tool overrides, changed executors and caller
spawn hooks remain caller-owned. Ownership uses the saved executor reference,
never function-source equality or a recreated factory closure. A session created
before the observer was loaded, or rebuilt while it was unloaded, has unknown
ownership and its native shell remains untouched. Such a shell or an existing
execute wrapper must supply any intended handoff itself. Public method/property
descriptors and later wrappers are preserved; reload restores only our own
wrappers. This boundary is specific to Pi 1.2.0 and must be reverified before
widening the supported version.

Native providers are delegated through Pi's public provider registration APIs. Wrappers bind requests by the actual invocation signal and preserve the original stream object, auth, options, and errors. Another extension replacing a provider remains authoritative; Sovara rebinds at the next run/context boundary and restores only registrations it still owns. Calls made independently by other extensions without the bound run signal are outside the Pi recording scope.

## Develop and validate this source preview

```sh
npm run bootstrap:sdk
npm run check
npm run test:package
```

`bootstrap:sdk` fetches the exact public commit in `SDK_REVISION`, installs its locked build dependencies, and builds and packs it. It verifies the SDK version and runs `npm ci` with the local artifact and its computed integrity, restoring the tracked lockfile afterward. Archive compression can differ across platforms; the source revision stays pinned. Other dependencies use the committed lockfile. Build output and evidence stay under ignored `.validation/`; no private checkout or credential is required.

The package test installs both real tarballs in a clean consumer, then exercises Pi's one-command package installer against an isolated registry serving the unpublished artifacts. It runs actual native tool-loop, MCP, streaming, cancellation, reload, and summary tests from the installed extension. Paid provider and persisted-server acceptance is separate from the offline suite.

This cutover removes the extension's custom runner client, `pi.llm` event recording, and retained context mutation. It requires the pinned SDK/server capabilities; there is no legacy recording fallback.

## License

MIT. The `@sovara/sdk` runtime dependency is Apache-2.0.
