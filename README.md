# Sovara for Pi

Record Pi sessions in Sovara and automatically retrieve relevant project lessons before each model step.
Requires **Pi 1.2.0+ (1.x)**, **Node.js 22.19+**, and a Sovara exec server supporting **runner-api 4**.
This is an early release. See the tracing limitations below.

## Install

Install once, then start Pi normally from your project directory:

```sh
pi install npm:@sovara/pi
pi
```

Inside an existing Pi session, run `/reload` after installation. Use `/sovara` to see the
selected server, local/remote mode, project, authentication state, and any recovery instructions.
Pi loads the TypeScript entry point directly; no build step is needed. Pi supplies its own runtime;
the extension does not install another Pi or download/start a remote Sovara server.

For a local connection, install the [Sovara CLI](https://docs.sovara-labs.com/cli/install)
and sign in with Sovara. For a remote connection, select and sign in to that server in Sovara
Desktop/CLI; the Pi extension reuses the saved selection and session. A headless setup can instead
set `SOVARA_EXEC_SERVER_URL` and `SOVARA_AGENT_TOKEN` without installing the CLI.

Update with `pi update`, then `/reload`. Remove with `pi remove npm:@sovara/pi`.
If you previously installed a Git/local checkout, remove that package with `pi remove <original-source>`
before adding the npm package, so the extension is loaded only once.

## Try it from a checkout

With Node.js 22.19+ and the Sovara CLI installed, install this checkout's dependencies
and launch the bundled Pi 1.2.0 with the extension explicitly loaded:

```sh
npm ci
./node_modules/.bin/pi -e ./src/index.ts
```

Inside Pi, use `/login` to connect your model provider, choose a model with `/model`, and run
`/sovara` to check the selected project. Try: “Read README.md and explain how this project works.”
After the turn settles, check the Sovara trace for model and tool observations. Applied lessons
appear on the LLM step as the usual badge and expandable lesson section. An empty lesson
collection is valid: the LLM has no applied-lesson badge.

To work in another project, launch from that directory using absolute paths to this checkout's
`node_modules/.bin/pi` and `src/index.ts`. The working directory selects the default Sovara project.
This explicit `-e` invocation loads the extension for that launch; it does not register a package.

## Connect and select a project

The extension uses the saved Sovara Desktop/CLI connection in `~/.sovara/app_connection.json`.
It reads the signed-in session from `~/.sovara/app_session.json` only for that saved server.
For an explicitly configured server, set `SOVARA_EXEC_SERVER_URL` and, where needed,
`SOVARA_AGENT_TOKEN` in your shell or secret manager. Without a saved connection or override,
the target is `http://127.0.0.1:5960`. For the saved Local connection (or the default local target),
Pi automatically runs `sovara exec-server start` if the connection is refused, then checks health
and runner-api compatibility again. Install the [Sovara CLI](https://docs.sovara-labs.com/cli/install)
so its bundled recording service is available. Startup is bounded to 60 seconds; failure is reported
without blocking normal Pi use indefinitely.

Remote connections and explicit `execUrl` / `SOVARA_EXEC_SERVER_URL` overrides are health-checked
only, even when they point at loopback (for example, an SSH tunnel). Those servers must already be
running. Authentication, HTTP, compatibility and malformed-response errors never trigger startup.

The default project name is the **startup working directory's basename**.
For example, starting Pi in `/work/backend` selects the Sovara project `backend`.
Sovara resolves or creates that project on the first recording, subject to the credential's
permissions. Project-bound agent tokens cannot create or select a different project.

Optional project configuration in `<cwd>/.pi/sovara.json`:

```json
{
  "projectName": "customer-support"
}
```

Only `projectName` is supported in the project file. There is no user-configured project ID.
Pi's project trust must be granted before this file is read. There is no ancestor-directory
search: launch Pi from the intended workspace. Repositories/worktrees sharing a project name
in the same Sovara organization share its lessons and traces. Set an explicit name when
unrelated folders have the same basename.

User defaults live in `~/.pi/agent/sovara.json` (or `$PI_CODING_AGENT_DIR/sovara.json`).
This user-level file also accepts `execUrl`. Project files cannot redirect credentials.
The server environment override takes precedence over the user-level URL.
Connection and credential changes take effect after `/reload` (or restarting Pi).
A reachable server is not proof that your credentials can write to the selected project;
authorization is checked when the first turn opens its recording.

## Automatic lesson retrieval

Before each normal agent model call, the extension retrieves lessons using the new suffix of Pi's
unified conversation and appends a request-local lesson message. There is no mode selection.
Use `/sovara` to inspect the project and recording status. A resumed session retains its original
project binding; a new session or fork takes the current configuration.

Automatic retrieval uses `context_with_system`, after Pi has assembled system/tool state. It
preserves that state and appends one custom message. It does not steer the agent, trigger another
turn, or persist injected messages into Pi's conversation. Old plugin messages are removed before
query construction. Retrieval uses only messages appended since the previous model input, excluding
system state and volatile metadata, in Sovara’s structured format with an empty prefix. Identical
inputs reuse the suffix query for retries. On resume or rewritten history (compaction/branching),
the baseline is the latest user turn, or the last message if no user message remains. Image bytes
are excluded from retrieval. Suffix text is capped at 128,000 characters, retaining its newest portion
inside valid structured JSON; this limit applies to the suffix, not the whole conversation. Injection is capped at approximately 12,000 characters; oversized lessons are
omitted whole. Both truncation decisions and the exact injected lesson IDs/text are recorded.
Other extensions registered later can still transform the context or provider payload.

Retrieval calls `/internal/lessons/retrieve` directly using the active recording's credentials and
project settings snapshot. The TypeScript SDK currently has no public standalone retrieval client;
its lesson injection is coupled to transport instrumentation, so this extension uses its narrow
HTTP client. No MCP connection is required.

The retrieval request is allowed up to 15 seconds; failures leave the agent running without added
lessons and are surfaced in the status. Trace export failures do not discard successfully retrieved
lessons. Caller cancellation interrupts recording and retrieval requests when Pi exposes an active run signal.
Pi does not expose that signal during `before_agent_start`, so startup registration remains bounded
by request timeouts. Turn cleanup shares one deadline across its writes: ten seconds normally,
shortened to at most one more second when cancellation is observed. Credential fields are
masked before suffix serialization. Sovara retrieval can consume configured model quota.

## Tracing

The recording follows the Pi session:

```text
Sovara project
└── Pi session (durable trace, external key pi:<session-id>)
    ├── User turn
    │   ├── LLM call (with applied lessons)
    │   ├── Tool execution / MCP call
    │   └── LLM call
    └── Next user turn
```

The adapter negotiates runner-api 4 before sending business requests. Each turn opens a recording
under the same durable session key and closes it when Pi settles. LLM steps include normalized Pi
context, the payload observed at the provider hook, output, exposed reasoning, usage/cache counts,
reported cost, first-token timing, and retrieval metadata. The display projection retains normalized
messages without duplicating provider payloads. Each LLM attempt owns its standard Sovara lesson
metadata: only the lessons actually injected, the exact injected text, retrieval timing/model/status,
and any warnings or errors. Retries and interrupted calls retain their own snapshots. Retrieval
creates no separate tool step. Existing Sovara lesson records and associations power the normal
badge and expanded lesson list; no schema changes are required. Tool IDs
correlate parallel start/end events. Nested tool IDs retain parent metadata. Retry attempts and interrupted operations are
closed explicitly. Failed finalization does not prevent recording a new attempt or exporting the
last observed answer. Independent cleanup errors remain visible. Known Sovara credential values and
conventional credential fields are masked before structured values are encoded, including run input/output.

Child Pi processes inherit the parent project. Those that load the extension and inherit its `SOVARA_PI_PARENT` environment attach
as Sovara subruns beneath the active parent turn. This environment contains short-lived recording
credentials; do not log or persist it. In-process subagents and processes that strip this environment
need explicit context propagation. A fork has a new trace key and retains its Pi parent-session
reference in recorded model inputs.

Compaction and branch summaries are recorded from Pi's summary events, with usage when supplied.
They do not receive lesson injection; provider inputs are included only when Pi exposes them.
Failed compaction is recorded as a failed summary. There is no claim of capturing hidden reasoning,
raw HTTP bytes, or model calls performed internally by arbitrary third-party tools.

This is observational capture, **not certified Sovara step replay support**. Pi provider-hook
payloads are stored with their provenance rather than presented as intercepted HTTP requests.
Images remain in captured context/payloads; there is no separate media-upload integration.

Writes have timeouts. The footer says “turn export acknowledged” only after successful API calls;
it does not claim durable persistence or exactly-once delivery. Failures show “export incomplete”.
Retrieval warnings appear in Pi and under `/sovara`, and are retained in the LLM step's lesson
metadata. Failed or skipped retrieval adds no applied lessons, even when the model succeeds.
A successful export does not mean lessons were injected.
For example, if Sovara reports an unverified Fast Helper Model, configure and verify that model
in Sovara before trying the prompt again. Pi's own model login does not configure Sovara's helper.
Headless sessions get a metadata-only stderr warning. There is no offline spool/backfill. A hard
process kill or unreachable server can lose observations. Inspect `/sovara` for status and reload
after repairing a failed initial connection. Remove/disable the extension with Pi's package controls
when you do not want session contents sent to Sovara.

## Development and verification

```sh
npm ci
npm run check
npm run test:package
```

Tests include Pi's actual extension loader and agent loop with a synthetic provider. They verify
suffix extraction, direct API retrieval, lesson injection, and tracing without paid model calls.
The package smoke test serves the actual npm tarball through a temporary registry, installs it
with Pi into an isolated agent directory, and runs the same integration and connection/startup
checks against the installed files. It never changes your Pi settings or uses your npm credentials.

An optional test runs the real Sovara exec server against a temporary database and verifies persisted
turns, steps, token usage, project creation, session continuation, and the lesson badge/detail
payloads used by the Sovara UI:

```sh
SOVARA_SOURCE_DIR=/path/to/sovara npm run test:backend
```

The Sovara checkout needs its `.venv` populated by `uv sync`. This test never uses your normal
Sovara database or hosted project and makes no paid model calls. It currently targets the runner-api 4
implementation. CI runs the standalone and package checks on Node 22 and 24. See [RELEASING.md](https://github.com/SovaraLabs/pi-sovara/blob/main/RELEASING.md)
for tag releases through npm trusted publishing.
