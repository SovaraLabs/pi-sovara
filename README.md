# Sovara for Pi

Record Pi sessions in Sovara and experiment with three ways of supplying project lessons.
Requires **Pi 1.2.0+ (1.x)**, **Node.js 22.19+**, and a Sovara exec server supporting **runner-api 4**.
This package is experimental and has not been published to npm yet.

## Install

Until the first release, install the implementation branch from GitHub:

```sh
pi install git:github.com/SovaraLabs/pi-sovara@codex/pi-integration
```

Or clone and install a local checkout:

```sh
git clone https://github.com/SovaraLabs/pi-sovara.git
cd pi-sovara
git switch codex/pi-integration
npm ci
pi install "$PWD"
```

After publication, the npm installation command will be `pi install npm:@sovara/pi`.
Pi loads the TypeScript entry point directly; no build step is needed.

## Connect and select a project

The extension uses the saved Sovara Desktop/CLI connection in `~/.sovara/app_connection.json`.
It reads the signed-in session from `~/.sovara/app_session.json` only for that saved server.
For an explicitly configured server, set `SOVARA_EXEC_SERVER_URL` and, where needed,
`SOVARA_AGENT_TOKEN` in your shell or secret manager. Without a saved connection or override,
the target is `http://127.0.0.1:5960`. The server must already be running.

The default project name is the **startup working directory's basename**.
For example, starting Pi in `/work/backend` selects the Sovara project `backend`.
Sovara resolves or creates that project on the first recording, subject to the credential's
permissions. Project-bound agent tokens cannot create or select a different project.

Optional project configuration in `<cwd>/.pi/sovara.json`:

```json
{
  "projectName": "customer-support",
  "lessonMode": "automatic"
}
```

Only these two keys are supported in the project file. There is no user-configured project ID.
Pi's project trust must be granted before this file is read. There is no ancestor-directory
search: launch Pi from the intended workspace. Repositories/worktrees sharing a project name
in the same Sovara organization share its lessons and traces. Set an explicit name when
unrelated folders have the same basename.

User defaults live in `~/.pi/agent/sovara.json` (or `$PI_CODING_AGENT_DIR/sovara.json`).
This user-level file also accepts `execUrl`. Project files cannot redirect credentials.
The server environment override takes precedence over the user-level URL.

## Lesson modes

| Mode                  | Behavior                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automatic` (default) | Before each normal agent model call, retrieve using the new suffix of its Pi transcript and append a request-local lesson message. No model decision or MCP call is needed.            |
| `mcp-reminder`        | Append a request-local reminder to use your configured Sovara MCP server. Suppress it after a retrieval result; re-arm it after new user input or other tool results. |
| `mcp-system`          | Add a standing system instruction to use your configured Sovara MCP server. No per-step reminder or automatic retrieval.                                                         |

Inside Pi:

```text
/sovara
/sovara mode automatic
/sovara mode mcp-reminder
/sovara mode mcp-system
```

Mode changes are saved for **new sessions**. Use `/new` to apply one. A resumed session keeps
the project name and mode recorded in its session metadata; a fork takes the current configuration.
Use fresh sessions for comparisons so earlier lesson/tool messages do not contaminate another mode.

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

For the MCP modes, connect Pi to **Sovara's existing remote MCP server** using Pi's
normal MCP configuration and authentication. The extension does not start, register, configure,
or authenticate any MCP server. Name the configured server `sovara` and expose its `retrieve`
tool directly so the reminder hook recognizes `mcp__sovara__retrieve` results. Select the intended
project through the remote tool's normal arguments; the recording project does not automatically
bind an independently configured MCP connection. See [Sovara MCP setup](https://docs.sovara-labs.com/mcp/overview).

Automatic mode calls `/internal/lessons/retrieve` directly using the active recording's credentials.
It needs no MCP connection. The TypeScript SDK currently has no public standalone retrieval client;
its lesson injection is coupled to transport instrumentation, so this extension uses its narrow
HTTP client instead. Disable the separately configured MCP server when comparing automatic mode
if you want to exclude model-requested MCP retrieval from that experiment.

Automatic retrieval is allowed up to 15 seconds; failures leave the agent running without added
lessons and are surfaced in the status. MCP reminders are instructions, not enforced tool calls.
Sovara retrieval itself can consume configured model quota. Automatic retrieval uses the recording's
project settings snapshot; remote MCP retrieval uses its own connection and selected project.

## Tracing

Tracing is enabled in every mode:

```text
Sovara project
└── Pi session (durable trace, external key pi:<session-id>)
    ├── User turn
    │   ├── Automatic retrieval, when enabled
    │   ├── LLM call
    │   ├── Tool execution / MCP call
    │   └── LLM call
    └── Next user turn
```

The adapter negotiates runner-api 4 before sending business requests. Each turn opens a recording
under the same durable session key and closes it when Pi settles. LLM steps include normalized Pi
context, the payload observed at the provider hook, output, exposed reasoning, usage/cache counts,
reported cost, first-token timing, and lesson-mode metadata. Tool IDs correlate parallel start/end
events. Nested tool IDs retain parent metadata. Retry attempts and interrupted operations are
closed explicitly. Known Sovara credential values and conventional credential fields are masked.

Child Pi processes inherit the parent project and lesson mode. Those that load the extension and inherit its `SOVARA_PI_PARENT` environment attach
as Sovara subruns beneath the active parent turn. This environment contains short-lived recording
credentials; do not log or persist it. In-process subagents and processes that strip this environment
need explicit context propagation. A fork has a new trace key and retains its Pi parent-session
reference in recorded model inputs.

Compaction and branch summaries are recorded from Pi's summary events, with usage when supplied.
They do not run the lesson experiment; provider inputs are included only when Pi exposes them.
Failed compaction is recorded as a failed summary. There is no claim of capturing hidden reasoning,
raw HTTP bytes, or model calls performed internally by arbitrary third-party tools.

This is observational capture, **not certified Sovara step replay support**. Pi provider-hook
payloads are stored with their provenance rather than presented as intercepted HTTP requests.
Images remain in captured context/payloads; there is no separate media-upload integration.

Writes have timeouts. The footer says “turn export acknowledged” only after successful API calls;
it does not claim durable persistence or exactly-once delivery. Failures show “export incomplete”.
Headless sessions get a metadata-only stderr warning. There is no offline spool/backfill. A hard
process kill or unreachable server can lose observations. Inspect `/sovara` for status and reload
after repairing a failed initial connection. Remove/disable the extension with Pi's package controls
when you do not want session contents sent to Sovara.

## Development and verification

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests include Pi's actual extension loader and agent loop with a synthetic provider. They verify
automatic API retrieval and both instruction modes without paid model calls. Remote MCP setup and
transport are owned by Pi and are not exercised by this suite.

An optional test runs the real Sovara exec server against a temporary database and verifies persisted
turns, steps, token usage, project creation and session continuation:

```sh
SOVARA_SOURCE_DIR=/path/to/sovara npm run test:backend
```

The Sovara checkout needs its `.venv` populated by `uv sync`. This test never uses your normal
Sovara database or hosted project and makes no paid model calls. It currently targets the runner-api 4
implementation. CI runs the standalone checks on Node 22 and 24; it does not publish packages.
