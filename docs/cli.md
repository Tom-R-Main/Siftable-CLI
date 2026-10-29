# Siftable CLI reference

`@siftable/cli` is the command-line interface to [Siftable](https://siftable.io) — your tasks, agent work queues, knowledge, calendar, people, code intelligence, datasets, research, and encrypted vault, scriptable from the shell.

This page is the complete reference: it documents **every command and flag** in the CLI, generated from the command definitions so it stays true to the installed version. For the terminal copilot, see [interactive.md](./interactive.md).

- **Version of this doc:** generated against the published manifest; run `sift --version` to see your installed version.
- **Two ways in:** every domain is also exposed over the [Siftable MCP server](https://www.npmjs.com/package/@siftable/mcp-server) for editors and agents. This page is the CLI surface.

## Install

```bash
# Run directly, no install
npx @siftable/cli <command>

# Install globally
npm install  -g @siftable/cli     # npm
bun  install -g @siftable/cli     # bun
pnpm add     -g @siftable/cli     # pnpm
```

The binary installs as **`sift`**, with **`siftable`** as an explicit alias and **`exf`** as a backwards-compatibility alias for older automations. All three run the same program.

## Authentication

```bash
sift auth login     # browser/device login; stores credentials locally
sift auth status    # show how you're authenticated
sift auth logout    # clear stored credentials
```

`sift auth login` runs a device flow and writes credentials to `~/.config/siftable/auth.json`. For headless or CI use, set a Personal Access Token instead:

```bash
export SIFT_TOKEN=sift_pat_your_token_here
```

Mint a PAT with `POST /api/v1/tokens` (or from the Siftable web app). Token resolution order is: `--token` flag → `SIFT_TOKEN` → `EXF_TOKEN` → the stored config file.

## Global flags

Every command accepts these:

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--token <pat>` | `SIFT_TOKEN` (`EXF_TOKEN`) | — | Personal access token |
| `--api-url <url>` | `SIFT_API_URL` (`EXF_API_URL`) | `https://siftable.io` | API base URL |
| `--workspace <id>` | `SIFT_WORKSPACE_ID` (`EXF_WORKSPACE_ID`) | — | Workspace (org) ID to scope operations to |
| `--json` | — | off | Emit raw JSON instead of formatted tables |
| `--no-input` | — | off | Disable interactive prompts (for scripts/CI) |

## Conventions

- **JSON output.** Add `--json` to any command for machine-readable output. This is the contract for scripting — formatted tables are for humans and may change.
- **IDs.** Resources are referenced by UUID. Some commands (e.g. `sift work get`) also accept a unique ID prefix.
- **Destructive commands** require an explicit confirmation flag — typically `--confirm` (bulk deletes, which otherwise preview) or `-y, --yes` (single deletes). Without it they no-op or print a preview.
- **Workspace scoping.** Pass `--workspace`/`SIFT_WORKSPACE_ID` to operate inside a specific workspace org; otherwise commands run against your personal scope.
- **Incremental authorization.** AI model discovery, invocation, usage, and connection use plus Vault metadata, management, and audit access require explicit scopes via `sift auth login --scope <scope>`; reserved AI management scopes are unavailable through device authorization, and `mcp:*` grants none of these capabilities.
- **Vault plaintext is destination-bound, never returned by the CLI.** Use `sift vault materialize run` for one field or define `.sift/environment.yaml` and use `sift env pull` for an approved bundle.

## Diagnostics

Read-only commands that never print secrets:

```bash
sift doctor         # auth, API URL, workspace, manifest readiness, with "next step" hints
sift capabilities   # which capability surfaces (datasets, research, viz, agent work…) are ready
sift commands       # agent-friendly command topics and workflow entry points
```

## Scripting

`--json` makes the CLI composable:

```bash
# List in-progress tasks
sift tasks list --json | jq '.tasks[] | select(.status == "in_progress")'

# Create a planning task and capture its ID
TASK_ID=$(sift tasks create --title "Deploy v2" --json | jq -r '.task.id')

# Create executable agent work linked to that task
sift work create --task "$TASK_ID" --agent codex \
  --title "Implement Deploy v2" --verify "npm run build;npm test"

# In CI
export SIFT_TOKEN=sift_pat_...
sift tasks complete "$TASK_ID"
```

### Tasks vs. work vs. agents

- **`sift tasks`** — human planning: outcomes, priority, acceptance criteria, project linkage, approval.
- **`sift work`** — executable agent packets: claim leases, assigned aliases, write scope, verification commands, artifacts, review state.
- **`sift agents`** — user-visible executor identities (aliases), their capabilities and default permissions.

Link work to a planning task with `sift work create --task <task-id>` rather than assigning an executor directly to a task.

### Following and steering running work

`sift work watch`, `attach`, `send`, `interrupt`, `approve` and `answer` act on a work item that is already running. They call the Sift API only: none of them starts a model process or connects to the agent runtime directly. The one process they may start is your platform's URL opener (`open`, `xdg-open` or `rundll32`), for `approve` and `answer`.

```bash
sift work watch "$WORK_ID"                    # follow until the live attempt ends
sift work attach "$WORK_ID"                   # recent ledger + follow; typed lines become instructions
sift work send "$WORK_ID" "Also update the README" --wait
sift work interrupt "$WORK_ID" --wait
sift work approve "$WORK_ID"                  # opens the web app to decide; waits for the outcome
sift work answer "$WORK_ID" "$REQUEST_ID" --no-browser
```

**watch / attach.** Reads the ledger from an explicit sequence with `GET /events/wait` (long-poll) and refreshes the execution attempt, runtime requests and runtime controls after each poll window. It never reads or advances a durable consumer cursor. Without `--after-sequence` it starts at the ledger's current end. The API has no read for the latest sequence, so the CLI reads pages forward from the start and writes nothing until a short page confirms the end. If 1,000 pages (100,000 events) do not reach the end, it exits 1 and asks for `--after-sequence`. Open requests in the snapshot come from `GET /runtime-requests?open=true`. When an attempt it saw live is no longer live, it reads every remaining ledger page (at most 100 pages, within `--timeout`; a request still running at the deadline is aborted) and then stops (`--keep-following` to continue). An attempt that was live when the watch began, or that started and ended while the CLI was finding the ledger end, counts as seen live. It also stops after `--timeout` seconds, on Ctrl-C, or immediately with `--once`. `--timeout` bounds every read, including the start scan and the long-poll: a read still running at the deadline is aborted and the watch ends with reason `timeout` (or `drain_incomplete` during the final drain), while Ctrl-C always ends with reason `signal`. With `--json` the output is JSON Lines, one record per line, each with `version: 1` and a `type`:

| `type` | Fields |
|---|---|
| `snapshot` | `workItemId`, `afterSequence` (ledger cursor), `attempt` (live attempt or `null`), `leaseActive`, `openRequests[]`, `openControls[]` (queued or dispatching) |
| `event` | `event`: a ledger event as returned by `GET /events` |
| `attempt` | `attempt`, `leaseActive`: the live attempt changed |
| `request` | `request`: a runtime request appeared or changed state or delivery state |
| `control` | `control`: a runtime control appeared or changed state |
| `control_unconfirmed` | attach only. `kind`, `instruction`, `idempotencyKey`, `cause`, `httpStatus`: a typed control the server may or may not have queued. `cause` is `signal` or `timeout` when the watch stopped mid-send, `watch_failed` when a watch read failed mid-send, `transport` when no response could be read after every retry, or `http` when retries ended on 408, a 5xx, or a 4xx without a parseable refusal (`httpStatus` holds the status, else `null`). Resend with the same `--idempotency-key` to get the stored control instead of a duplicate. Once any attempt is ambiguous, the control stays unconfirmed with that key even if a later retry gets a parsed 4xx; `cause` and `httpStatus` describe the first ambiguous attempt. Only a 4xx with a parsed error body on every attempt is reported as not accepted. If Ctrl-C or `--timeout` stops a control still being sent while `attach` is shutting down after the attempt ended, the `end` record reports `signal` or `timeout` rather than `attempt_ended` |
| `drain_incomplete` | `cause` (`page_limit` or `timeout`), `afterSequence`: the attempt ended but events after `afterSequence` were not read. The `end` record that follows has reason `drain_incomplete`, and the command exits 1 |
| `end` | `reason` (`attempt_ended`, `drain_incomplete`, `timeout`, `once`, `signal`), `afterSequence`; pass it to `--after-sequence` to resume |

`attach` reads typed lines only from a terminal, and not with `--no-input` or `--once`: a line queues an instruction, `/interrupt` interrupts the turn, `/quit` detaches. Lines are sent one at a time in the order typed, so the server queues them in that order. Before writing its `end` record (on `/quit`, end of input or attempt end), `attach` waits until every line already typed has been sent and its `control` record written. Ctrl-C, `--timeout` and a failed watch read also cut short a control that is still being sent: it is reported as `control_unconfirmed`, and lines queued behind it are not sent. `attach` exits 1 if any typed control was refused, unconfirmed or not sent, as `send` and `interrupt` do for those outcomes.

**send / interrupt.** `POST /runtime-controls` with `{kind: "instruction", instruction}` or `{kind: "interrupt"}`. Each invocation generates one `Idempotency-Key` (or uses `--idempotency-key`) and reuses it for its retries after a transport error (including a response body cut off mid-read), 408, 429 or any 500–599 status, so a retry never queues a second control. Output (`--json`):

```json
{"version": 1, "applied": true, "control": {"id": "…", "kind": "instruction", "state": "queued", "…": "…"}, "idempotencyKey": "cli-instruction-…", "requestAttempts": 1}
```

If every attempt fails without proving the server refused the control (no readable response, 408, a 5xx, or a 4xx without a parseable error body), the outcome is unknown. The command exits 1, the text output names the key to retry with, and `--json` prints:

```json
{"version": 1, "ok": false, "outcome": "unconfirmed", "kind": "instruction", "idempotencyKey": "cli-instruction-…", "requestAttempts": 3, "cause": "http", "httpStatus": 503}
```

`cause` is `transport` (no readable response; `httpStatus` is `null`) or `http`. Rerun with `--idempotency-key` set to that key: a stored control comes back with `applied: false` instead of a duplicate. Once any attempt is ambiguous the result stays unconfirmed, even if a later retry gets a parsed 4xx such as 429 or 409; `cause` and `httpStatus` describe the first ambiguous attempt. Only when no attempt was ambiguous is a parsed 4xx a definite refusal, reported as a normal error.

`applied: false` means the server returned an existing control: a retry of the same key, or an interrupt that was already open. `control.state` is exactly what the server recorded: `queued`, `dispatching`, `delivered`, `acknowledged`, `cancelled`, `failed`, `expired` or `unconfirmed`. An instruction is delivered only at `delivered`; an interrupt is acknowledged only at `acknowledged`. With `--wait` the command polls until a final state or `--timeout`, adds `settled: boolean`, and exits 1 unless the instruction reached `delivered` or the interrupt reached `acknowledged`. A read still running at the deadline is aborted. When it stops unsettled, `stoppedBy` is `timeout`, or `signal` for Ctrl-C (exit 130), and `control` is the last state the server recorded.

**approve / answer.** The server refuses access tokens (PATs and delegated OAuth) for resolving runtime requests, so the CLI never calls `POST /runtime-requests/:requestId/resolve`. It opens the web app page for the request, where you decide with your signed-in session, then reads the request by ID with `GET /runtime-requests/:requestId` until it leaves `pending`. Without a request ID it picks the only open approval (or question) from `GET /runtime-requests?open=true`. The CLI starts the opener and waits up to 3 seconds for it to start. If it cannot start (for example, no `xdg-open` on a headless machine), `browserOpened` is `false` and the text output asks you to open the printed URL yourself. The decision page is:

```
<app origin>/app/work/<workItemId>?request=<requestId>
```

The app origin is `--app-url`, else `SIFT_APP_URL`, else the `--api-url` origin (`http://localhost:8080` maps to the local web client on `:3000`). With `--json` the output is JSON Lines. While the request is pending, the first line is written before the command starts waiting, so a script using `--no-browser` can hand the URL to a person:

```json
{"version": 1, "type": "decision_required", "workItemId": "…", "requestId": "…", "kind": "approval", "url": "https://siftable.io/app/work/…?request=…", "browserOpened": false}
```

The last line is the outcome (the only line when the request was already closed):

```json
{"version": 1, "type": "outcome", "workItemId": "…", "requestId": "…", "kind": "approval", "decisionUrl": "https://siftable.io/app/work/…?request=…", "browserOpened": true, "outcome": "resolved", "request": {"state": "resolved", "resolution": {"decision": "accept"}, "deliveryState": "delivered", "…": "…"}}
```

The exact read is not limited by the 100-request list cap, so an older request and its stored outcome stay readable after newer requests arrive. `outcome` is the request's stored state: `resolved`, `expired` or `superseded` (including `closeReason: "attempt_ended"` when the attempt ended before a decision), `timed_out` (still pending at `--timeout`; a read still running at the deadline is aborted), or `interrupted` (still pending when Ctrl-C stopped the wait). The command exits 0 only for `resolved`, 130 for `interrupted`, and 1 otherwise. `request.resolution` holds the stored decision, and `request.deliveryState` says whether it reached the agent.

---

## Command reference

All 360 commands, grouped by topic. Every command also accepts the [global flags](#global-flags) (`--json`, `--token`, `--api-url`, `--workspace`, `--no-input`).

**Topics:** [General](#general) · [Agent](#agent) · [Agents](#agents) · [Ai](#ai) · [Approvals](#approvals) · [Auth](#auth) · [Billing](#billing) · [Calendar](#calendar) · [Capabilities](#capabilities) · [Code](#code) · [Codebase](#codebase) · [Codex](#codex) · [Compute](#compute) · [Context](#context) · [Crm](#crm) · [Datasets](#datasets) · [Documents](#documents) · [Env](#env) · [Events](#events) · [Evidence](#evidence) · [Grants](#grants) · [Graph](#graph) · [Lead-discovery](#lead-discovery) · [Machine](#machine) · [Notes](#notes) · [Organizations](#organizations) · [People](#people) · [Projects](#projects) · [Recipes](#recipes) · [Relationships](#relationships) · [Research](#research) · [Skills](#skills) · [Tasks](#tasks) · [Timeline](#timeline) · [Vault](#vault) · [Work](#work) · [Worker](#worker) · [Workspaces](#workspaces)


### General

Top-level commands and diagnostics.

#### `sift capabilities`
Show Siftable CLI capabilities and readiness status

#### `sift commands`
Show agent-friendly command topics and workflow entry points

#### `sift doctor`
Diagnose local Siftable CLI configuration without printing secrets

#### `sift interactive`
Launch the Siftable terminal copilot (sift interactive) — an in-process AI assistant over your tasks, work, calendar, projects, and people.

**Flags**

- `--connected-models` — List eligible connected models and exit
- `--connection <value>` *(needs model)* — Select a Model Connection UUID for a gateway invocation
- `--max-output-tokens <value>` *(needs prompt)* — Maximum connected-model output tokens (1-32768)
- `--model <value>` — Select an eligible connected model for a gateway invocation
- `--prompt <value>` *(needs model)* — Invoke the selected connected model once and exit
- `--stream` *(needs prompt)* — Consume selected connected-model output incrementally

#### `sift mermaid`
Render a Mermaid diagram to the terminal (flowchart, sequence, state, class, ER, C4, architecture, mindmap). Reads a .mmd file or stdin.

**Arguments**

- `file` — Path to a .mmd file (omit to read stdin)

**Flags**

- `--ascii` — Use ASCII glyphs instead of Unicode box drawing
- `--color <none|truecolor>` *(default: "truecolor")* — Color mode
- `--height <value>` — Fit into an exact N-row pane (pads/clips)
- `--max-height <value>` — Bound the diagram to N rows (no padding)
- `--max-width <value>` — Bound the diagram to N columns (no padding)
- `--overflow <allow|clip|error>` *(default: "clip")* — What to do when the diagram exceeds the bounds
- `--unicode` — Use Unicode box drawing (default)
- `--width <value>` — Fit into an exact N-column pane (pads/clips)

#### `sift review`
Review committed changes with Taster before opening a pull request. Runs locally through your Codex login. --repo selects the checkout; --expected-head asserts its full commit ID. Only committed changes are reviewed. An incomplete review is never reported as clean. --receipt also saves a full companion report and a durable attempt record, including failures and interruptions. Exit status: 0 clean or advisory findings only, 1 blocking (P0-P1) findings, 2 incomplete, skipped or failed.

**Flags**

- `--base <value>` — Base ref to review against (default: origin/main, then main)
- `--codex-bin <value>` — Absolute path of the Codex binary (default: codex on PATH)
- `--concurrency <value>` *(default: 2)* — Concurrent Codex runs
- `--deadline-ms <value>` *(default: 1800000)* — Whole-review deadline, including setup and pre-pass, in milliseconds
- `--expected-head <value>` — Require this full committed HEAD before starting review
- `--finder-passes <value>` *(default: 2)* — Finder passes with different file orderings (2 or 3)
- `--max-files <value>` *(default: 60)* — Changed files to review; more are skipped and the review is incomplete
- `--max-model-calls <value>` *(default: 40)* — Model call ceiling for the whole review
- `--model <value>` *(default: "gpt-6.1-sol")* — Model for finders and validators
- `--receipt <value>` — Write the revision-bound receipt, plus <path>.report.json and <path>.attempt.json
- `--repo <value>` — Repository checkout to review (default: current directory)
- `--report <value>` — Write the full review report to this path (overrides the companion report path)


### Agent

#### `sift agent run`
Run Sift’s local agent harness headlessly with durable session events

**Flags**

- `--approval <deny|allow>` *(default: "deny")* — Tool approval policy; allow approves local tool requests. Shell commands run with host permissions
- `--base-url <value>` — Compatible provider endpoint (HTTPS or loopback HTTP)
- `--cwd <value>` — Local workspace directory and writable root (defaults to current directory)
- `--deadline-ms <value>` *(default: 600000)* — Turn deadline in milliseconds
- `--effort <none|minimal|low|medium|high|xhigh|max>` — Provider reasoning effort
- `--format <jsonl|json|text>` *(default: "jsonl")* — Output protocol (--json selects json)
- `--handoff-timeout-ms <value>` — Maximum external grading handoff duration
- `--max-output-tokens <value>` — Maximum provider output tokens
- `--max-rounds <value>` *(default: 24)* — Maximum tool rounds
- `--model <value>` *(required)* — Exact provider model ID
- `--prompt <value>` *(required)* — Task for the local agent
- `--provider <value>` *(required)* — Provider adapter; credentials are read from the environment
- `--session <value>` — Resume this session ID; defaults to a fresh session
- `--supervisor-handoff` — Keep session jobs owned during external grading; requires a supervisor stdin pipe and JSONL
- `--verify-command <value>` — Explicit post-run check as a JSON argv array; requires --verify-file
- `--verify-file <value>` *(repeatable)* — Exact candidate file to bind to the check (repeat for each file)


### Agents

Agent aliases.

#### `sift agents create`
Create an agent alias

**Flags**

- `--alias <value>` *(required)* — Stable alias slug, e.g. codex
- `--capabilities <value>` — Capabilities JSON object
- `--hidden` — Hide from normal user-visible lists
- `--name <value>` — Display name
- `--operator <value>` — Linked daemon/operator ID
- `--permissions <value>` — Default permissions JSON object
- `--type <value>` *(default: "custom")* — Agent type

#### `sift agents disable`
Disable an agent alias

**Arguments**

- `alias` *(required)* — Agent alias or ID

#### `sift agents get`
Get an agent alias

**Arguments**

- `alias` *(required)* — Agent alias or ID

#### `sift agents list`
List agent aliases

**Flags**

- `--include-disabled` — Include disabled aliases

#### `sift agents update`
Update an agent alias

**Arguments**

- `alias` *(required)* — Agent alias or ID

**Flags**

- `--capabilities <value>` — Capabilities JSON object
- `--hidden` — Hide from normal user-visible lists
- `--name <value>` — Display name
- `--operator <value>` — Linked daemon/operator ID
- `--permissions <value>` — Default permissions JSON object
- `--status <active|disabled>` — Alias status
- `--type <value>` — Agent type
- `--visible` — Show in normal user-visible lists

#### `sift agents work`
List work assigned to an agent alias

**Arguments**

- `alias` *(required)* — Agent alias or ID

**Flags**

- `--limit <value>` — Maximum results
- `--status <value>` — Work item status


### Ai

#### `sift ai connect`
Show the secure browser flow for adding a non-exportable Model Connection

**Flags**

- `--url <value>` *(default: "https://siftable.io/settings/model-connections")* — Siftable Model Connections settings URL

#### `sift ai invoke`
Invoke an eligible connected model (requires ai:invoke and ai:connections:use)

**Flags**

- `--connection <value>` *(required)* — Model Connection UUID returned by sift ai list
- `--max-output-tokens <value>` — Maximum output tokens (1-32768)
- `--model <value>` *(required)* — Eligible model ID returned by sift ai list
- `--prompt <value>` *(required)* — Prompt text
- `--stream` — Consume and print incremental connected-model output

#### `sift ai list`
List eligible connected models (requires ai:models:read)

#### `sift ai status`
Show non-secret Model Connection status (requires ai:connections:use)

**Arguments**

- `connection` — Optional Model Connection UUID

#### `sift ai usage`
Show connected-model usage totals (requires ai:usage:read)

**Flags**

- `--from <value>` — ISO-8601 period start
- `--to <value>` — ISO-8601 period end


### Approvals

#### `sift approvals request`
Request a governed action approval; this command cannot approve or consume it

**Flags**

- `--action <value>` *(required)* — Governed action identifier
- `--destination <value>` *(default: "{}")* — Destination binding JSON object
- `--expires-in <value>` — Approval lifetime in seconds (30-600)
- `--operation <value>` *(required)* — Operation identifier
- `--purpose <value>` *(required)* — Human-readable non-secret purpose
- `--resource-id <value>` *(required)* — Resource identifier
- `--resource-type <value>` *(required)* — Resource type identifier

#### `sift approvals status`
Inspect a governed approval requested by this CLI identity

**Arguments**

- `id` *(required)* — Approval ID


### Auth

Authentication commands.

#### `sift auth login`
Authenticate with Siftable

**Flags**

- `--scope <ai:models:read|ai:invoke|ai:usage:read|ai:connections:use|vault:metadata:read|vault:manage|vault:audit:read>` *(repeatable)* — Incremental AI invocation or Vault scope to request (repeatable; management AI scopes and plaintext reveal are unavailable)

#### `sift auth logout`
Remove stored authentication

#### `sift auth status`
Show authentication status


### Billing

#### `sift billing fallback decide`
Allow, deny, or always allow personal funding for a quoted workspace operation

**Flags**

- `--decision <allow|deny|always_allow>` *(required)*
- `--monthly-cap-micros <value>` — Monthly micro-USD cap for always_allow
- `--quote <value>` *(required)* — Server-issued operation quote ID

#### `sift billing fallback policy`
Read or update the workspace personal-fallback policy

**Flags**

- `--disabled` — Disable and revoke personal fallback
- `--enabled` — Enable personal fallback

#### `sift billing fallback revoke`
Revoke one of your active personal-fallback consents

**Arguments**

- `consentId` *(required)*

#### `sift billing fallback status`
Show your active personal-fallback decisions for a workspace


### Calendar

Calendar events.

#### `sift calendar create`
Create a calendar event

**Flags**

- `--description <value>` — Event description
- `--end <value>` *(required)* — End time (ISO 8601)
- `--location <value>` — Event location
- `--start <value>` *(required)* — Start time (ISO 8601)
- `--title <value>` *(required)* — Event title

#### `sift calendar delete`
Delete a calendar event

**Arguments**

- `id` *(required)* — Event ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift calendar list`
List calendar events

**Flags**

- `--end <value>` — End date (ISO 8601)
- `--limit <value>` — Maximum number of results
- `--start <value>` — Start date (ISO 8601)

#### `sift calendar update`
Update a calendar event

**Arguments**

- `id` *(required)* — Event ID

**Flags**

- `--description <value>` — Event description
- `--end <value>` — End time (ISO 8601)
- `--location <value>` — Event location
- `--start <value>` — Start time (ISO 8601)
- `--title <value>` — Event title


### Capabilities

#### `sift capabilities create`
Create a reviewed server-brokered Vault capability

**Flags**

- `--adapter <value>` *(required)* — Reviewed static adapter ID
- `--expires-in <value>` — Lifetime in seconds (300-2592000)
- `--field <value>` *(default: "value")* — Credential payload field
- `--operation <value>` *(required)* — Comma-separated allowlisted operations
- `--provider <value>` *(required)* — Provider ID
- `--purpose <value>` *(required)* — Non-secret human-readable purpose
- `--vault-entry <value>` *(required)* — Vault entry UUID

#### `sift capabilities describe`
Describe safe metadata for one Vault capability

**Arguments**

- `id` *(required)* — Capability metadata ID

#### `sift capabilities execute`
Execute one typed operation through a Vault capability handle

**Flags**

- `--approval <value>` — Governed approval UUID when required
- `--handle <value>` *(required)* — Opaque vcap_ capability handle
- `--idempotency-key <value>` — Stable 8-128 character key for safe retries
- `--input <value>` *(default: "{}")* — Typed operation input JSON object
- `--operation <value>` *(required)* — Allowlisted operation

#### `sift capabilities list`
List safe metadata for Vault capability handles

#### `sift capabilities revoke`
Revoke a Vault capability

**Arguments**

- `id` *(required)* — Capability metadata ID


### Code

Code tools.

#### `sift code blame`
Git blame for a file

**Arguments**

- `file` *(required)* — Relative file path

**Flags**

- `--root <value>` *(default: ".")* — Repository root path

#### `sift code memory confirm`
Confirm a code memory candidate with an auditable reason

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `--reason <value>` *(required)* — Audit reason

#### `sift code memory delete`
Delete a stored curated code fact

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift code memory detect-stale`
Detect likely-stale code memories and mark them needs_review (never deletes)

**Flags**

- `--limit <value>` — Maximum memories to scan
- `--repo <value>` — Repository ID

#### `sift code memory edit`
Edit a code memory in place; previous content stays in the audit ledger

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `--confidence <value>` — Confidence 0-1
- `--fact <value>` *(required)* — Updated fact
- `--reason <value>` *(required)* — Audit reason

#### `sift code memory events`
List append-only curation/lineage events for a code memory

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `--limit <value>` — Maximum number of events

#### `sift code memory get`
Show one code memory with provenance, evidence, and lifecycle

**Arguments**

- `id` *(required)* — Memory ID

#### `sift code memory list`
List stored curated code facts (excludes rejected/superseded by default)

**Flags**

- `--include-inactive` — Include rejected and superseded lineage memories
- `--lifecycle <unreviewed|confirmed|rejected|superseded|needs_review>` — Filter by lifecycle state
- `--limit <value>` — Maximum number of results
- `--repo <value>` — Repository ID

#### `sift code memory needs-review`
Mark a code memory needs_review for likely staleness/contradiction (never deletes)

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `--reason <value>` *(required)* — Audit reason
- `--signal <value>` *(repeatable)* — Staleness signal (repeatable)

#### `sift code memory reject`
Reject a code memory with an auditable reason (soft-reject; never deletes)

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `--reason <value>` *(required)* — Audit reason

#### `sift code memory search`
Search stored curated code facts (excludes rejected/superseded by default)

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--category <architecture|integration|convention|entrypoint|gotcha|ownership>` — Filter by category
- `--include-inactive` — Include rejected and superseded lineage memories
- `--lifecycle <unreviewed|confirmed|rejected|superseded|needs_review>` — Filter by lifecycle state
- `--limit <value>` — Maximum number of results
- `--repo <value>` — Repository ID

#### `sift code memory store`
Store a curated code fact

**Flags**

- `--agent <value>` — Authoring agent (marks memory as agent-authored)
- `--category <architecture|integration|convention|entrypoint|gotcha|ownership>` *(required)* — Fact category
- `--commit <value>` — Source commit SHA
- `--confidence <value>` — Confidence 0-1
- `--evidence-chunk <value>` *(repeatable)* — Historical indexed chunk ID supporting the fact
- `--fact <value>` *(required)* — Fact to store (1-2 sentences)
- `--file <value>` — Related file path
- `--path <value>` *(repeatable)* — Additional related path (repeatable)
- `--reason <value>` — Capture reason (required with --agent)
- `--repo <value>` — Repository ID
- `--work-item <value>` — Related agent work item ID

#### `sift code memory supersede`
Supersede a code memory with a new fact; old memory retained as lineage

**Arguments**

- `id` *(required)* — Memory ID to supersede

**Flags**

- `--category <architecture|integration|convention|entrypoint|gotcha|ownership>` — Fact category (defaults to previous)
- `--commit <value>` — Source commit SHA
- `--confidence <value>` — Confidence 0-1
- `--evidence-chunk <value>` *(repeatable)* — Evidence chunk ID (repeatable)
- `--fact <value>` *(required)* — Replacement fact
- `--file <value>` — Related file path
- `--path <value>` *(repeatable)* — Additional related path (repeatable)
- `--reason <value>` *(required)* — Audit reason


### Codebase

#### `sift codebase search`
Explain the retired source-code search command and its local recovery

**Arguments**

- `query` — Legacy source-code search query


### Codex

Codex automation helpers.

#### `sift codex daily-review collect`
Collect read-only Siftable and local git context for Codex daily work reviews

**Flags**

- `--calendar-days <value>` *(default: 7)* — Calendar lookahead days
- `--limit <value>` *(default: 20)* — Maximum records per source
- `--skip-git` — Skip local git summary


### Compute

#### `sift compute get`
Inspect a compute grant, its dispatch, and cleanup state

**Arguments**

- `grantId` *(required)* — Compute grant ID

#### `sift compute list`
List this credential's compute grants

#### `sift compute request`
Request human authorization to launch managed compute for one work-item revision

**Arguments**

- `workItemId` *(required)* — Work item ID

**Flags**

- `--idempotency-key <value>` — Explicit idempotency key for safe retries
- `--purpose <value>` *(required)* — Human-readable purpose shown on the approval
- `--revision <value>` *(required)* — Expected work-item revision
- `--runner <value>` *(required)* — Runner ID advertising a managed compute profile

#### `sift compute runners`
List managed runners advertising a compute profile

**Flags**

- `--work-item <value>` — Check runner eligibility for this work item

#### `sift compute start`
Start the single approved dispatch for a compute grant

**Arguments**

- `grantId` *(required)* — Compute grant ID

**Flags**

- `--idempotency-key <value>` — Explicit idempotency key for safe retries

#### `sift compute stop`
Request stop on a compute grant's running dispatch

**Arguments**

- `grantId` *(required)* — Compute grant ID

**Flags**

- `--idempotency-key <value>` — Explicit idempotency key for safe retries


### Context

#### `sift context current`
Explain the current principal, owner, project, and local checkout context

**Flags**

- `--workspace-root <value>` — Absolute local checkout root to describe (never sent as a workspace tenant ID)


### Crm

#### `sift crm import apply`
Apply only approved operations from an existing CRM import plan; replay is safe

**Arguments**

- `planId` *(required)* — Durable CRM import plan UUID

**Flags**

- `--yes` — Confirm canonical CRM writes without prompting

#### `sift crm import approve`
Approve all or selected pending operations in an existing CRM import plan

**Arguments**

- `planId` *(required)* — Durable CRM import plan UUID

**Flags**

- `--operation-id <value>` *(repeatable)* — Stable operation ID to approve; repeat to approve a subset
- `--reason <value>` *(required)* — Human approval reason recorded on the plan
- `--yes` — Confirm the approval without prompting

#### `sift crm import get`
Resume and inspect a durable CRM import plan by stable plan ID

**Arguments**

- `planId` *(required)* — Durable CRM import plan UUID

#### `sift crm import plan`
Create or reuse a durable CRM import plan from CSV, TSV, XLS, or XLSX without writing canonical CRM records

**Arguments**

- `file` *(required)* — Local CSV, TSV, XLS, or XLSX source (8 MiB maximum)

**Flags**

- `--mapping-mode <manual|workspace_auto>` *(default: "manual")* — Manual mapping or approved workspace mapping profile
- `--provider <generic|salesforce>` *(default: "generic")* — Source provider mapping

#### `sift crm organizations convert`
Explain the governed boundary between a CRM organization and a workspace

**Arguments**

- `id` *(required)* — CRM organization ID

#### `sift crm organizations list`
List CRM organizations only; collaborative workspaces are excluded

**Flags**

- `--limit <value>` *(default: 100)* — Maximum number of CRM results
- `--search <value>` — Optional fuzzy search query


### Datasets

Structured datasets.

#### `sift datasets add`
Add records to a dataset

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation
- `--record <value>` *(repeatable)* — Record as JSON object, e.g. '{"name":"Alice","age":"30"}'
- `--records <value>` — Multiple records as JSON array

#### `sift datasets aggregate`
Aggregate dataset records with grouped metrics (count, avg, sum, min, max, median, stddev, percentile, ratio)

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--filters <value>` — JSON array of filters
- `--group-by <value>` — Comma-separated field names to group by
- `--having <value>` — JSON array of having clauses [{metric, operator, value}]
- `--limit <value>` *(default: 100)* — Max rows
- `--metrics <value>` — JSON array of metrics [{operation, field, as}]
- `--sorts <value>` — JSON array of sorts

#### `sift datasets analyze`
Generate grounded natural-language insights for a dataset

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--filters <value>` — JSON array of filters
- `--focus-fields <value>` — Comma-separated field names to focus analysis on
- `--max-insights <value>` *(default: 5)* — Max insights to generate
- `--mode <descriptive|operational>` — Analysis mode
- `--signal-limit <value>` — Max decision signals to return

#### `sift datasets apply-diff`
Apply a saved dataset diff plan

**Arguments**

- `plan` *(required)* — Path to a local diff plan or persisted diff plan ID

**Flags**

- `--yes` — Confirm applying the saved diff plan without prompting

#### `sift datasets archive`
Archive a dataset without dropping its physical table

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `-y, --yes` — Confirm dataset archival without prompting

#### `sift datasets bucket`
Bucket a numeric or date field into ranges with aggregate metrics per bucket

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--boundaries <value>` — Comma-separated boundary values (omit for auto-bucketing)
- `--bucket-count <value>` — Number of auto-buckets (default: 5)
- `--field <value>` *(required)* — Field to bucket
- `--filters <value>` — JSON array of filters
- `--metrics <value>` — JSON array of metrics

#### `sift datasets cleanup`
Plan or apply cleanup for lifecycle-tagged scratch datasets

**Flags**

- `--dry-run` — Return a deterministic cleanup plan without deleting datasets
- `--lifecycle <value>` — Lifecycle kind to clean, e.g. scratch, benchmark, research-run
- `--limit <value>` *(default: 100)* — Maximum lifecycle datasets to inspect
- `--now <value>` — Deterministic timestamp for tests and scheduled cleanup
- `--older-than <value>` — Only include datasets older than this duration, e.g. 12h, 7d
- `--orphaned` — Include stale dataset notes that no longer have a backing dataset row
- `--tag <value>` — Lifecycle tag to clean, e.g. benchmark
- `-y, --yes` — Confirm deletion when applying cleanup with --no-dry-run

#### `sift datasets compare`
Compare metrics across segments of a categorical field side-by-side

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--filters <value>` — JSON array of filters
- `--limit <value>` *(default: 10)* — Max segment values to compare
- `--metrics <value>` — JSON array of metrics
- `--segment-field <value>` *(required)* — Categorical field to segment by
- `--segment-values <value>` — Comma-separated segment values (auto-discovers if omitted)

#### `sift datasets compute`
Compute derived fields from a dataset or prior derived result

**Arguments**

- `id` — Dataset ID

**Flags**

- `--computed-fields <value>` *(required)* — JSON array of computed fields, e.g. '[{"as":"spread","expression":"right.Close-left.Close"}]'
- `--filters <value>` — JSON array of filters
- `--limit <value>` *(default: 50)* — Maximum rows
- `--order-by <value>` — JSON array of order clauses
- `--select <value>` — Comma-separated fields to include
- `--sorts <value>` — JSON array of output sorts
- `--source-result <value>` — Inline JSON for a prior derived result
- `--source-result-file <value>` — Path to a JSON file containing a prior derived result

#### `sift datasets contract`
Show an agent-readable dataset schema and capabilities contract

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--resolve <value>` — Comma-separated semantic field references to resolve
- `--template <value>` — Validate contract against a built-in template

#### `sift datasets create`
Create a dataset

**Flags**

- `--description <value>` — Dataset description
- `--fields <value>` — Field definitions as JSON array, e.g. '[{"name":"age","type":"number"}]'
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation
- `--lifecycle <value>` — Lifecycle kind for generated datasets, e.g. scratch, benchmark, research-run
- `--metadata <value>` — Dataset metadata as JSON object
- `--note-id <value>` — Link to an existing note
- `--run-id <value>` — Lifecycle run identifier
- `--scratch` — Shortcut for --lifecycle scratch --tags scratch
- `--tags <value>` — Comma-separated lifecycle tags
- `--title <value>` *(required)* — Dataset title
- `--ttl <value>` — Lifecycle TTL duration, e.g. 12h, 7d, 30d

#### `sift datasets dedupe`
Find duplicate dataset records by key without mutating data

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--key <value>` *(required)* — Field name used to group duplicates
- `--limit <value>` *(default: 500)* — Maximum records to scan in one bounded pass

#### `sift datasets delete`
Permanently delete a dataset and drop its physical table

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `-y, --yes` — Confirm dataset deletion without prompting

#### `sift datasets delete-record`
Delete a record from a dataset

**Arguments**

- `id` *(required)* — Dataset ID
- `record-id` *(required)* — Record ID

**Flags**

- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation
- `-y, --yes` — Skip confirmation

#### `sift datasets diff`
Preview dataset row changes from a CSV, JSON, or JSONL file

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--batch-size <value>` *(default: 100)* — Records per backend batch
- `--from-file <value>` *(required)* — Path to CSV, JSON, or JSONL rows to compare
- `--persist` — Persist the diff plan in Siftable for later review/apply
- `--save-plan <value>` — Write an applyable diff plan JSON file
- `--template <sources|people|events|claims|evidence_sources|evidence_source_fragments|evidence_claims|evidence_people|evidence_organizations|evidence_places|evidence_artifacts|evidence_events|evidence_relationships|evidence_contradictions>` — Built-in template name
- `--upsert-by <value>` — Field name used to match existing rows

#### `sift datasets diff-plans list`
List persisted dataset diff plans

**Flags**

- `--dataset-id <value>` — Filter by dataset ID
- `--limit <value>` *(default: 50)* — Maximum plans to return
- `--status <draft|validated|applied|rejected|expired>` — Filter by plan status

#### `sift datasets diff-plans show`
Show a persisted dataset diff plan

**Arguments**

- `id` *(required)* — Diff plan ID

#### `sift datasets export`
Export bounded dataset records as CSV, JSON, JSONL, or Markdown

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--filters <value>` — JSON array of filters
- `--format <csv|json|jsonl|markdown>` *(default: "csv")* — Export format
- `--limit <value>` *(default: 500)* — Max rows to export
- `-o, --output <value>` — Output file path (writes to stdout if omitted)
- `--sorts <value>` — JSON array of sorts

#### `sift datasets facets`
Show bounded facet summaries for dataset fields

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--fields <value>` — Comma-separated field names to facet
- `--limit <value>` *(default: 20)* — Maximum values per facet

#### `sift datasets formula-plan`
Compute formula fields and preview reviewable dataset updates

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--computed-fields <value>` *(required)* — JSON array of computed fields, e.g. '[{"as":"score","expression":"confidence * reliability"}]'
- `--filters <value>` — JSON array of filters for compute source
- `--limit <value>` *(default: 100)* — Maximum rows to compute and plan
- `--order-by <value>` — JSON array of order clauses
- `--save-plan <value>` — Write an applyable diff plan JSON file
- `--select <value>` — Comma-separated fields to include in compute source
- `--sorts <value>` — JSON array of output sorts
- `--target-fields <value>` — Comma-separated computed field names to write; defaults to every computed field alias
- `--template <sources|people|events|claims>` — Built-in template name for validation
- `--upsert-by <value>` *(required)* — Field used to match rows for update

#### `sift datasets get`
Get dataset details and schema

**Arguments**

- `id` *(required)* — Dataset ID

#### `sift datasets impact`
Explain dataset formula, graph, view, quality, and materialization impact

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--from-plan <value>` — Persisted diff plan ID to inspect
- `--operation <value>` — Committed dataset operation ID to inspect

#### `sift datasets import`
Import CSV, JSON, or JSONL rows into a new or existing dataset

**Arguments**

- `file` *(required)* — Path to CSV, JSON, or JSONL file

**Flags**

- `--batch-size <value>` *(default: 100)* — Records per backend batch
- `--dataset-id <value>` — Import into existing dataset instead of creating a new one
- `--description <value>` — Dataset description
- `--dry-run` — Validate and plan the import without writing
- `--lifecycle <value>` — Lifecycle kind for generated datasets, e.g. scratch, benchmark, research-run
- `--metadata <value>` — Dataset metadata as JSON object when creating a new dataset
- `--run-id <value>` — Lifecycle run identifier
- `--scratch` — Shortcut for --lifecycle scratch --tags scratch
- `--tags <value>` — Comma-separated lifecycle tags
- `--template <sources|people|events|claims|evidence_sources|evidence_source_fragments|evidence_claims|evidence_people|evidence_organizations|evidence_places|evidence_artifacts|evidence_events|evidence_relationships|evidence_contradictions>` — Built-in template name
- `--title <value>` — Dataset title (defaults to filename)
- `--ttl <value>` — Lifecycle TTL duration, e.g. 12h, 7d, 30d
- `--upsert-by <value>` — Field name used to update matching rows instead of creating duplicates
- `--yes` — Confirm mutating imports without prompting

#### `sift datasets inspect-file`
Inspect the structure of a local CSV, TSV, XLS, or XLSX file without creating or changing a dataset

**Arguments**

- `file` *(required)* — Path to a local CSV, TSV, XLS, or XLSX file

**Flags**

- `--delimiter <value>` — Single-byte delimiter override for CSV/TSV
- `--format <csv|tsv|xls|xlsx>` — Format override when the extension is absent or wrong
- `--header-row <value>` — Zero-based header row index within the sheet grid
- `--max-bytes <value>` — Refuse files larger than this many bytes
- `--max-cols <value>` — Maximum columns returned per sheet
- `--max-rows <value>` — Maximum data rows returned per sheet
- `--max-sheets <value>` — Maximum sheets returned
- `--sheet <value>` — Inspect only this sheet; the full sheet inventory is still reported

#### `sift datasets join`
Join a dataset to itself using alias-scoped fields such as left.Close and right.Close

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--join-keys <value>` *(required)* — JSON array of join keys, e.g. '[{"leftField":"Date","rightField":"Date"}]'
- `--join-type <inner|left|right>` *(default: "inner")* — Join type
- `--left-alias <value>` *(default: "left")* — Left alias
- `--left-filters <value>` — JSON array of left-side filters
- `--limit <value>` *(default: 50)* — Maximum joined rows
- `--right-alias <value>` *(default: "right")* — Right alias
- `--right-filters <value>` — JSON array of right-side filters
- `--select <value>` — Comma-separated alias-scoped fields to return
- `--sorts <value>` — JSON array of sorts

#### `sift datasets list`
List datasets

**Flags**

- `--limit <value>` *(default: 50)* — Maximum number of results

#### `sift datasets lookup`
Lookup dataset records by an exact key/value match

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--key <value>` *(required)* — Field name to match
- `--limit <value>` *(default: 25)* — Maximum matching records
- `--value <value>` *(required)* — Exact value to match

#### `sift datasets materialize`
Materialize a derived result into a new scratch dataset

**Flags**

- `--description <value>` — Dataset description
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation
- `--source-result <value>` — Inline JSON for a derived result
- `--source-result-file <value>` — Path to a JSON file containing a derived result
- `--title <value>` *(required)* — Title of the new dataset

#### `sift datasets pivot`
Create a pivot-style summary from grouped dataset metrics

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--cols <value>` *(required)* — Column field
- `--filters <value>` — JSON array of filters
- `--limit <value>` *(default: 500)* — Maximum grouped cells to request
- `--metrics <value>` — JSON metrics array; defaults to count
- `--rows <value>` *(required)* — Row field

#### `sift datasets plot`
Validate and normalize a lightweight plot payload from a derived result

**Flags**

- `--chart-type <line|bar|scatter>` *(required)* — Chart type
- `--series-field <value>` — Optional series field
- `--source-result <value>` — Inline JSON for a derived result
- `--source-result-file <value>` — Path to a JSON file containing a derived result
- `--x-field <value>` *(required)* — X-axis field
- `--y-fields <value>` *(required)* — Comma-separated Y-axis fields

#### `sift datasets profile`
Show bounded profile information for a dataset

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--sample-limit <value>` *(default: 10)* — Number of sample rows to include

#### `sift datasets quality`
Check dataset quality with structured missing-value metrics and repeated-value observations

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--fields <value>` — Comma-separated field names to check
- `--repeat-threshold <value>` *(default: 3)* — Minimum occurrences for a repeated value to be reported

#### `sift datasets query`
Query records from a dataset

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--cursor <value>` — Pagination cursor from previous query
- `--filters <value>` — Filter conditions as JSON array, e.g. '[{"field":"status","value":"active"}]'
- `--include-deleted` — Include soft-deleted records
- `--limit <value>` *(default: 25)* — Maximum number of records
- `--sorts <value>` — Sort spec as JSON array, e.g. '[{"field":"name","direction":"asc"}]'

#### `sift datasets rank`
Rank dataset records by sorts or a weighted numeric formula

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--filters <value>` — JSON array of filters
- `--formula <value>` — JSON formula object {weights: [{field, weight}]}
- `--limit <value>` *(default: 25)* — Max rows
- `--sorts <value>` — JSON array of sorts

#### `sift datasets reconcile`
Compare two datasets by key without mutating either dataset

**Arguments**

- `left` *(required)* — Left dataset ID
- `right` *(required)* — Right dataset ID

**Flags**

- `--left-key <value>` *(required)* — Left dataset key field
- `--limit <value>` *(default: 500)* — Maximum rows to scan from each dataset
- `--right-key <value>` — Right dataset key field; defaults to --left-key

#### `sift datasets schema`
Modify dataset schema (add, update, or delete fields)

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--field <value>` — Field definition as JSON, e.g. '{"name":"email","type":"text"}'
- `--field-id <value>` — Field ID (required for update/delete)
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation
- `--operation <add_field|update_field|delete_field>` *(required)* — Schema operation

#### `sift datasets search`
Search dataset records across selected text-like fields

**Arguments**

- `id` *(required)* — Dataset ID
- `query` *(required)* — Search text

**Flags**

- `--fields <value>` — Comma-separated fields to search; defaults to profile columns
- `--filters <value>` — JSON array of base filters applied to every field search
- `--limit <value>` *(default: 25)* — Maximum merged records
- `--per-field-limit <value>` *(default: 25)* — Maximum records to request per searched field

#### `sift datasets summarize`
Get a summary of a dataset (row count, fields, sample rows)

**Arguments**

- `id` *(required)* — Dataset ID

#### `sift datasets templates list`
List built-in dataset templates

#### `sift datasets templates show`
Show a built-in dataset template schema

**Arguments**

- `template` *(required)* — Template name

#### `sift datasets timeseries`
Analyze dataset time series with lag, pct_change, rolling windows, drawdown, volatility, and correlation

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--date-field <value>` *(required)* — Date field name
- `--filters <value>` — JSON array of filters
- `--limit <value>` *(default: 100)* — Maximum output rows
- `--metrics <value>` — JSON array of metric definitions
- `--order-direction <asc|desc>` *(default: "asc")* — Time ordering
- `--pivot` — Emit explicit pivoted output
- `--segment-field <value>` — Optional segment field
- `--segment-values <value>` — Comma-separated segment values
- `--transforms <value>` — JSON array of transform definitions

#### `sift datasets update-record`
Update a record in a dataset

**Arguments**

- `id` *(required)* — Dataset ID
- `record-id` *(required)* — Record ID

**Flags**

- `--fields <value>` *(required)* — Field updates as JSON object, e.g. '{"status":"done"}'
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for replaying this exact dataset mutation

#### `sift datasets validate`
Validate a dataset against a built-in template

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

- `--template <sources|people|events|claims|evidence_sources|evidence_source_fragments|evidence_claims|evidence_people|evidence_organizations|evidence_places|evidence_artifacts|evidence_events|evidence_relationships|evidence_contradictions>` *(required)* — Built-in template name


### Documents

Document upload.

#### `sift documents upload`
Upload a document (PDF, Markdown, or text) as a note

**Arguments**

- `file` *(required)* — Path to file

**Flags**

- `--project <value>` — Project ID
- `--title <value>` — Note title (defaults to filename)
- `--type <note|concept|meeting|reference|daily|dataset>` — Note type


### Env

Declarative environment contracts and governed Vault bundle materialization.

#### `sift env check`
Validate the environment contract for local or CI use

**Flags**

- `--checkout-root <value>` — Exact Git checkout root containing .sift/environment.yaml
- `--ci` — Fail non-zero when contract, example, Git, or checkout safety findings exist

#### `sift env diff`
Show value-free environment contract drift

**Flags**

- `--checkout-root <value>` — Exact Git checkout root containing .sift/environment.yaml

#### `sift env endpoint enroll`
Enroll a public endpoint identity without granting Vault access

**Flags**

- `--dedicated` — Endpoint is a dedicated runner
- `--endpoint-class <interactive_desktop|remote_vm|noninteractive_runner|shared_host|ci_runner|production_host|multi_tenant>` *(required)* — Explicit endpoint policy class
- `--kill-switch` — Runner has an enforced kill switch
- `--owner <value>` *(default: "personal")* — personal or workspace:<uuid>
- `--storage-tier <hardware_host_bound|systemd_managed|convenience_keyring|none>` *(required)* — Actual endpoint key storage tier; convenience_keyring is not hardware-backed

#### `sift env example`
Generate a deterministic names-and-placeholders-only example

**Flags**

- `--checkout-root <value>` — Exact Git checkout root containing .sift/environment.yaml
- `--write` — Write the deterministic output to .env.example instead of displaying it

#### `sift env export contract`
Export the environment contract (metadata only, never values)

**Flags**

- `--checkout-root <value>` — Checkout containing .sift/environment.yaml
- `--format <value>` *(required)* — Export format: json or csv
- `--output <value>` — New local output file to create (O_EXCL); prints to stdout when omitted
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift env import apply`
Apply one exact reviewed dotenv or CSV import plan atomically

**Flags**

- `--checkout-root <value>` — Checkout used only to reject Sift-managed source files
- `--format <value>` *(default: "dotenv")* — Source format: dotenv or csv
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--plan-file <value>` *(required)* — Reviewed value-free plan artifact
- `--receipt-file <value>` — New local value-free import receipt to create (required for later source cleanup)
- `--source <value>` *(required)* — Same explicit source used to create the plan

#### `sift env import cleanup`
Remove one reviewed import source after a completed import

**Flags**

- `--checkout-root <value>` — Checkout used only to reject Sift-managed source files
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--receipt-file <value>` *(required)* — Value-free import receipt from the completed apply
- `--source <value>` *(required)* — Explicit import source file to remove
- `--yes` *(required)* — Fresh human confirmation for this removal

#### `sift env import plan`
Create a value-free, owner-scoped plan for one explicitly named dotenv or CSV source

**Flags**

- `--checkout-root <value>` — Checkout used only to reject Sift-managed source files
- `--decision <value>` *(repeatable)* — Explicit per-index decision: INDEX:keep-existing|overwrite|skip|rename=NAME
- `--delimiter <value>` — CSV delimiter: comma, semicolon, tab, or pipe
- `--format <value>` *(default: "dotenv")* — Source format: dotenv or csv
- `--header-row <value>` — CSV header row (1-based line number)
- `--map <value>` *(repeatable)* — CSV column mapping: field=DisplayedHeader (repeatable)
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--plan-file <value>` *(required)* — New local value-free plan artifact to create
- `--project <value>` — Exact owner-scoped project UUID
- `--source <value>` *(required)* — Explicit dotenv or CSV source file

#### `sift env pull`
Pull one exact governed Vault bundle into a Sift-managed development environment file

**Flags**

- `--approval-timeout <value>` *(default: 600)*
- `--checkout-root <value>` — Checkout containing .sift/environment.yaml
- `--destination <value>` — Exact relative destination when the manifest declares more than one bundle
- `--endpoint-class <development|production|ci|shared_host|policy_ineligible>` *(required)* — Explicit endpoint policy class; managed pulls accept development only
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--purpose <value>` *(required)*
- `--replace` — Replace a changed Sift-managed file using its exact observed precondition

#### `sift env push apply`
Apply one exact reviewed dotenv or CSV import plan atomically

**Flags**

- `--checkout-root <value>` — Checkout used only to reject Sift-managed source files
- `--format <value>` *(default: "dotenv")* — Source format: dotenv or csv
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--plan-file <value>` *(required)* — Reviewed value-free plan artifact
- `--receipt-file <value>` — New local value-free import receipt to create (required for later source cleanup)
- `--source <value>` *(required)* — Same explicit source used to create the plan

#### `sift env push plan`
Create a value-free, owner-scoped plan for one explicitly named dotenv or CSV source

**Flags**

- `--checkout-root <value>` — Checkout used only to reject Sift-managed source files
- `--decision <value>` *(repeatable)* — Explicit per-index decision: INDEX:keep-existing|overwrite|skip|rename=NAME
- `--delimiter <value>` — CSV delimiter: comma, semicolon, tab, or pipe
- `--format <value>` *(default: "dotenv")* — Source format: dotenv or csv
- `--header-row <value>` — CSV header row (1-based line number)
- `--map <value>` *(repeatable)* — CSV column mapping: field=DisplayedHeader (repeatable)
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--plan-file <value>` *(required)* — New local value-free plan artifact to create
- `--project <value>` — Exact owner-scoped project UUID
- `--source <value>` *(required)* — Explicit dotenv or CSV source file

#### `sift env rm`
Remove one exact Sift-managed local environment file

**Flags**

- `--checkout-root <value>` — Exact Git checkout root containing .sift/environment.yaml
- `--destination <value>` — Exact relative destination when the manifest declares more than one bundle
- `--yes` *(required)* — Confirm removal of the exact recognized managed file

#### `sift env status`
Report value-free local environment state

**Flags**

- `--checkout-root <value>` — Exact Git checkout root containing .sift/environment.yaml


### Events

Research events backed by timeline facts.

#### `sift events attach-person`
Attach a person participant to an existing research event

**Arguments**

- `event` *(required)* — Existing temporal fact ID
- `person` *(required)* — Person UUID to attach

**Flags**

- `--role <value>` *(default: "subject")* — Participant role
- `--yes` — Confirm participant attachment without prompting

#### `sift events create`
Create a research event timeline fact with participants

**Flags**

- `--body <value>` — Event notes/body
- `--confidence <low|medium|high>` — Confidence level
- `--entity <value>` *(repeatable)* — Participant/entity as type:uuid or type:uuid:role; repeatable
- `--org <value>` *(repeatable)* — Organization UUID participant; repeatable
- `--person <value>` *(repeatable)* — Person UUID participant; repeatable
- `--precision <millisecond|minute|hour|day|month|year|decade|century|millennium|mega_year|era>` *(default: "year")* — Temporal precision
- `--source <value>` *(repeatable)* — Source entity as type:uuid or type:uuid:role; repeatable
- `--source-label <value>` — Source/provenance label
- `--source-note <value>` — Source/provenance note
- `--source-url <value>` — Source/provenance URL
- `--timestamp <value>` — ISO timestamp
- `--title <value>` *(required)* — Event title
- `--visibility <org_public|private|restricted>` — Timeline visibility
- `--year <value>` — Historical year CE
- `--year-end <value>` — Historical end year CE

#### `sift events list`
List research event timeline facts

**Flags**

- `--cursor <value>` — Pagination cursor
- `--end <value>` — End boundary
- `--entity <value>` — Filter by entity ref type:uuid
- `--limit <value>` *(default: 50)* — Maximum events
- `--order <asc|desc>` *(default: "asc")* — Sort order
- `--person <value>` — Filter by person UUID
- `--q <value>` — Text search query
- `--start <value>` — Start boundary


### Evidence

Evidence Graph setup and proof workflow orchestration.

#### `sift evidence diff apply`
Apply a reviewed Evidence Graph diff plan

**Arguments**

- `id` *(required)* — Persisted diff plan ID

**Flags**

- `--yes` — Confirm applying the reviewed diff plan without prompting

#### `sift evidence diff impact`
Explain Evidence Graph consequences for a persisted diff plan

**Arguments**

- `id` *(required)* — Persisted diff plan ID, or local when using --from-file

**Flags**

- `--from-file <value>` — Local diff plan JSON file to explain without API access

#### `sift evidence diff list`
List persisted Evidence Graph diff plans

**Flags**

- `--dataset-id <value>` — Filter by evidence dataset ID
- `--limit <value>` *(default: 50)* — Maximum plans to return
- `--project <value>` — Filter locally by Evidence Graph project ID when present on plans
- `--status <draft|validated|applied|rejected|expired>` — Filter by plan status

#### `sift evidence diff show`
Show an Evidence Graph diff plan with domain-aware summary

**Arguments**

- `id` *(required)* — Persisted diff plan ID

#### `sift evidence extract`
Create no-apply agent work for Evidence Graph candidate extraction

**Flags**

- `--agent <value>` *(default: "researcher")* — Assigned agent alias
- `--context <value>` — Additional input context JSON object
- `--context-file <value>` — Additional input context JSON file
- `--dry-run` — Preview work item payload without writing
- `--no-apply` — Keep extraction in proposed/diff-first mode
- `--pack <company-origin|family-history|investigation|compliance-evidence|account-history|codebase-history>` *(default: "company-origin")* — Evidence workflow pack
- `--project <value>` — Project ID
- `--source-dataset <value>` *(required)* — Evidence sources dataset ID
- `--targets <value>` — Comma-separated extraction targets
- `--yes` — Confirm work item creation without prompting

#### `sift evidence init`
Create an Evidence Graph project and dataset-backed working tables

**Arguments**

- `name` *(required)* — Evidence Graph project name

**Flags**

- `--dry-run` — Preview project/dataset creation without writing
- `--pack <company-origin|family-history|investigation|compliance-evidence|account-history|codebase-history>` *(default: "company-origin")* — Evidence workflow pack
- `--yes` — Confirm creation without prompting

#### `sift evidence plan`
Plan an Evidence Graph workflow before writing trusted state

**Arguments**

- `goal` *(required)* — Evidence Graph goal

**Flags**

- `--pack <company-origin|family-history|investigation|compliance-evidence|account-history|codebase-history>` *(default: "company-origin")* — Evidence workflow pack
- `--project <value>` — Existing project ID
- `--source-dataset <value>` — Existing evidence sources dataset ID

#### `sift evidence project`
Dry-run Evidence Graph timeline and relationship projection

**Flags**

- `--dry-run` — Preview projection without writing
- `--from-file <value>` — Local diff plan JSON file to project from without API access
- `--from-plan <value>` — Persisted diff plan ID to project from
- `--pack <company-origin|family-history|investigation|compliance-evidence|account-history|codebase-history>` *(default: "company-origin")* — Evidence workflow pack
- `--project <value>` — Evidence Graph project ID

#### `sift evidence proof report`
Generate an Evidence Graph proof report from a dataset-backed evidence packet

**Flags**

- `--format <json|markdown>` *(default: "markdown")* — Report format
- `--from-file <value>` *(required)* — Evidence packet JSON file to report on
- `--project <value>` — Evidence Graph project ID for report metadata

#### `sift evidence sources import`
Import Evidence Graph source ledger rows into a dataset-backed source table

**Arguments**

- `file` *(required)* — Path to CSV, JSON, or JSONL source ledger rows

**Flags**

- `--batch-size <value>` *(default: 100)* — Records per backend batch
- `--dataset-id <value>` — Evidence sources dataset ID
- `--dry-run` — Validate and plan source import without writing
- `--upsert-by <value>` *(default: "source_id")* — Field name used to update matching source rows
- `--yes` — Confirm mutating imports without prompting

#### `sift evidence verify`
Verify Evidence Graph provenance, review, projection, and citation invariants

**Flags**

- `--from-file <value>` *(required)* — Evidence packet JSON file to verify
- `--project <value>` — Evidence Graph project ID for report metadata


### Grants

#### `sift grants adapters`
List reviewed local execution adapters and honest containment tiers

#### `sift grants request`
Request a human-approved grant for a pre-registered trusted local runner

**Flags**

- `--adapter <value>` *(required)*
- `--audience <value>` *(required)*
- `--credential-field <value>` *(required)*
- `--cwd <value>`
- `--executable <value>` *(required)* — Resolved reviewed executable path
- `--executable-digest <value>` *(required)*
- `--issuer <value>` *(required)*
- `--operation <value>` *(required)*
- `--purpose <value>` *(required)*
- `--runner-fingerprint <value>` *(required)*
- `--runner-public-key <value>` *(required)* — PEM public-key file from the trusted local runner
- `--scope <value>` *(required)* — Provider scope JSON with string values
- `--vault-entry <value>` *(required)*

#### `sift grants run`
Request approval, redeem in memory, and run exactly one reviewed child process

**Flags**

- `--adapter <github_gh|github_publish_pr|terraform_apply>` *(required)*
- `--approval-timeout <value>` *(default: 600)*
- `--audience <value>` *(required)*
- `--body-file <value>` — PR body file for github_publish_pr
- `--credential-field <value>` *(required)*
- `--cwd <value>`
- `--issuer <value>` *(required)*
- `--operation <value>` *(required)*
- `--purpose <value>` *(required)*
- `--scope <value>` *(required)*
- `--vault-entry <value>` *(required)*

#### `sift grants status`
Inspect safe status for an ephemeral local execution grant

**Arguments**

- `id` *(required)*


### Graph

Entity graph search and neighborhoods.

#### `sift graph between`
Explain a bounded graph path between two entities

**Arguments**

- `source` *(required)* — Source entity reference as type:uuid
- `target` *(required)* — Target entity reference as type:uuid

**Flags**

- `--depth <value>` *(default: 4)* — Maximum path depth, backend clamps to 1-5
- `--frontier-limit <value>` *(default: 500)* — Maximum links to inspect per path expansion, backend clamps to 1-1000

#### `sift graph explain`
Explain a bounded graph path between two entities

**Arguments**

- `source` *(required)* — Source entity reference as type:uuid
- `target` *(required)* — Target entity reference as type:uuid

**Flags**

- `--depth <value>` *(default: 4)* — Maximum path depth, backend clamps to 1-5
- `--frontier-limit <value>` *(default: 500)* — Maximum links to inspect per path expansion, backend clamps to 1-1000

#### `sift graph neighbors`
Show local graph neighbors for an entity

**Arguments**

- `entity` *(required)* — Entity reference as type:uuid

**Flags**

- `--depth <value>` *(default: 1)* — Graph depth, backend clamps to 1-3
- `--limit <value>` *(default: 80)* — Maximum graph items, backend clamps to 1-200

#### `sift graph preview`
Preview one graph entity

**Arguments**

- `entity` *(required)* — Entity reference as type:uuid

#### `sift graph search`
Search linkable entities for graph work

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--limit <value>` *(default: 20)* — Maximum results
- `--types <value>` — Comma-separated entity types


### Lead-discovery

#### `sift lead-discovery candidates list`
List source-backed review candidates for a durable discovery run

**Arguments**

- `runId` *(required)* — Discovery run UUID

#### `sift lead-discovery candidates review`
Versioned shortlist, reject, or restore of one discovery candidate

**Arguments**

- `candidateId` *(required)* — Discovery candidate UUID

**Flags**

- `--expected-review-version <value>` *(required)* — Current review version used for optimistic concurrency
- `--idempotency-key <value>` — Stable retry key; generated when omitted
- `--reason-code <value>` *(required)* — Structured shortlist/reject reason code
- `--reason-note <value>` — Optional private review note
- `--state <discovered|shortlisted|rejected>` *(required)* — New review state

#### `sift lead-discovery candidates review-many`
Review up to 25 discovery candidates with ordered per-item receipts

**Flags**

- `--reviews <value>` — Exact versioned review commands as a JSON array
- `--reviews-file <value>` — Path to exact versioned review commands JSON array

#### `sift lead-discovery companies prepare`
Prepare an exact company-discovery quote without dispatching provider work

**Flags**

- `--idempotency-key <value>` — Stable retry key; generated when omitted
- `--query <value>` — Exact lead-discovery query JSON object
- `--query-file <value>` — Path to an exact lead-discovery query JSON object
- `--target-kind <organization|organization_person>` *(default: "organization")* — Discovery target kind

#### `sift lead-discovery companies run`
Run one exact opaque prepared company-discovery contract

**Arguments**

- `preparedQueryId` *(required)* — Opaque prepared-query UUID

**Flags**

- `--approved-maximum-charge-micros <value>` *(required)* — Exact maximum charge returned by prepare and approved by the caller
- `--query-digest <value>` *(required)* — Exact digest returned by prepare

#### `sift lead-discovery companies search`
Prepare and run a bounded company search under an explicit approved maximum charge

**Flags**

- `--idempotency-key <value>` — Stable retry key; generated when omitted
- `--maximum-charge-micros <value>` *(required)* — Caller-approved charge ceiling in micro-USD
- `--query <value>` — Exact lead-discovery query JSON object
- `--query-file <value>` — Path to an exact lead-discovery query JSON object

#### `sift lead-discovery import-plan create`
Create or recover the import plan bound to an exact reviewed shortlist

**Arguments**

- `runId` *(required)* — Discovery run UUID

**Flags**

- `--candidate-id <value>` *(required; repeatable)* — Shortlisted candidate UUID; repeat for each candidate
- `--expected-shortlist-digest <value>` *(required)* — Exact 64-character shortlist digest
- `--idempotency-key <value>` — Stable retry key; generated when omitted

#### `sift lead-discovery import-plan lookup`
Recover the import plan bound to a run and exact shortlist digest

**Arguments**

- `runId` *(required)* — Discovery run UUID

**Flags**

- `--expected-shortlist-digest <value>` *(required)* — Exact 64-character shortlist digest

#### `sift lead-discovery origin get`
Get persisted discovery-origin evidence for an imported organization

**Arguments**

- `organizationId` *(required)* — Organization UUID

#### `sift lead-discovery runs get`
Recover durable discovery run status and receipt by stable run ID

**Arguments**

- `runId` *(required)* — Discovery run UUID


### Machine

#### `sift machine enroll`
Enroll this Linux machine as a contained supervisor (run as root)

**Flags**

- `--abandon-runner <value>` *(needs replace)* — With --replace: the runner you revoked in the browser, when the old state cannot revoke itself
- `--replace` — Revoke and retire this machine's current enrollment, then enroll again
- `--setup <value>` — Setup session this machine is enrolled for (recorded locally)

#### `sift machine qualify`
Qualify this enrolled machine: run the isolation probes in the pinned agent image and report them (run as root)

**Flags**

- `--start-over` — Retire a report the server refused, keeping it under retired/, and qualify again

#### `sift machine service`
Install or remove the systemd service that runs the supervisor (run as root)

**Arguments**

- `action` *(required)* — install writes, enables and starts the unit; uninstall stops, disables and removes it

#### `sift machine status`
Show this machine's supervisor enrollment (run as root; never prints the credential)

#### `sift machine supervise`
Run this machine's contained supervisor: claim work, run it in the sandbox, stop and clean up (run as root, normally by systemd)

**Flags**

- `--once` — Run at most one attempt, then exit
- `--plan-file <value>` — Root-owned JSON plan used for every dispatch (test fixture until setup launches record plans)


### Notes

Knowledge notes.

#### `sift notes bulk-delete`
Preview or bulk-delete notes

**Flags**

- `--archived` — Filter by archived state
- `--confirm` — Execute deletion instead of preview
- `--ids <value>` — Comma-separated note IDs
- `--title-contains <value>` — Title substring filter
- `--title-equals <value>` — Exact title filter
- `--title-starts-with <value>` — Title prefix filter
- `--type <note|concept|meeting|reference|daily|dataset>`

#### `sift notes create`
Create a note

**Flags**

- `--content <value>` — Note content (markdown)
- `--metadata <value>` — Note metadata as JSON
- `--metadata-file <value>` — Read note metadata JSON from a file
- `--project <value>` — Project ID
- `--title <value>` *(required)* — Note title
- `--type <note|concept|meeting|reference|daily|dataset>` — Note type

#### `sift notes delete`
Delete a note

**Arguments**

- `id` *(required)* — Note ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift notes get`
Get a note with full content

**Arguments**

- `id` *(required)* — Note ID

#### `sift notes list`
List notes

**Flags**

- `--archived` — Filter by archived state
- `--limit <value>` — Maximum number of results
- `--project <value>` — Filter by project ID
- `--title-contains <value>` — Title substring filter
- `--title-equals <value>` — Exact title filter
- `--title-starts-with <value>` — Title prefix filter
- `--type <note|concept|meeting|reference|daily|dataset>` — Filter by note type

#### `sift notes search`
Search notes

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--limit <value>` — Maximum number of results
- `--project <value>` — Filter by project ID

#### `sift notes update`
Update a note

**Arguments**

- `id` *(required)* — Note ID

**Flags**

- `--content <value>` — Note content (markdown)
- `--metadata <value>` — Replace note metadata with this JSON object
- `--metadata-file <value>` — Read replacement note metadata JSON from a file
- `--title <value>` — Note title
- `--type <note|concept|meeting|reference|daily|dataset>` — Note type


### Organizations

Organizations and companies.

#### `sift organizations bulk-delete`
Preview or bulk-delete organizations

**Flags**

- `--confirm` — Execute deletion instead of preview
- `--contains <value>` — Name substring filter
- `--equals <value>` — Exact name filter
- `--ids <value>` — Comma-separated organization IDs
- `--relationship <value>` — Filter by relationship status
- `--starts-with <value>` — Name prefix filter
- `--type <value>` — Filter by organization type

#### `sift organizations create`
Create an organization

**Flags**

- `--domain <value>` — Domain (e.g. acme.com)
- `--industry <value>` — Industry
- `--linkedin-url <value>` — LinkedIn page URL
- `--location <value>` — Location
- `--name <value>` *(required)* — Organization name
- `--notes <value>` — Notes
- `--relationship-status <value>` — Relationship status (e.g. prospect, customer, partner, vendor)
- `--type <value>` — Organization type (e.g. company, nonprofit, government, school)
- `--website <value>` — Website URL

#### `sift organizations delete`
Delete an organization

**Arguments**

- `id` *(required)* — Organization ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift organizations search`
Search organizations

**Arguments**

- `query` — Optional fuzzy search query

**Flags**

- `--contains <value>` — Name substring filter
- `--equals <value>` — Exact name filter
- `--limit <value>` — Maximum number of results
- `--relationship <value>` — Filter by relationship status
- `--starts-with <value>` — Name prefix filter
- `--type <value>` — Filter by organization type

#### `sift organizations update`
Update an organization

**Arguments**

- `id` *(required)* — Organization ID

**Flags**

- `--domain <value>` — Domain (e.g. acme.com)
- `--industry <value>` — Industry
- `--linkedin-url <value>` — LinkedIn page URL
- `--location <value>` — Location
- `--name <value>` — Organization name
- `--notes <value>` — Notes
- `--relationship-status <value>` — Relationship status
- `--type <value>` — Organization type
- `--website <value>` — Website URL


### People

People and contacts.

#### `sift people bulk-delete`
Preview or bulk-delete contacts

**Flags**

- `--confirm` — Execute deletion instead of preview
- `--contains <value>` — Name substring filter
- `--equals <value>` — Exact name filter
- `--has-no-email` — Only contacts without an email
- `--ids <value>` — Comma-separated person IDs
- `--relationship <value>` — Filter by relationshipToUser
- `--starts-with <value>` — Name prefix filter

#### `sift people context add`
Add an owner-relative Personal or Work relationship

**Arguments**

- `personId` *(required)* — Person ID

**Flags**

- `--basis <value>` — Why this relationship is recorded
- `--confidence <value>` — Evidence confidence from 0 to 1
- `--context <personal|work>` *(required)* — Relationship context
- `--primary` — Make this the primary relationship in its context
- `--relationship <value>` *(required)* — Relationship type, e.g. friend, client, mentor

#### `sift people context list`
List how the current owner knows a person

**Arguments**

- `personId` *(required)* — Person ID

#### `sift people context remove`
Remove an owner-relative relationship context

**Arguments**

- `personId` *(required)* — Person ID
- `relationshipId` *(required)* — Context relationship ID

**Flags**

- `--dry-run` — Show what would be removed without writing
- `-y, --yes` — Remove without prompting

#### `sift people create`
Create a contact

**Flags**

- `--birth-year <value>` — Birth year
- `--birthday <value>` — Birthday (YYYY-MM-DD)
- `--company <value>` — Company name (auto-links to organization if exists)
- `--context <personal|work>` *(repeatable)* — How you know this person; repeat for both contexts
- `--email <value>` — Email address
- `--estimated-age <value>` — Estimated age
- `--job-title <value>` — Job title
- `--linkedin-url <value>` — LinkedIn profile URL
- `--location <value>` — Location
- `--mbti <value>` — MBTI type (e.g. INTJ, ENFP)
- `--name <value>` *(required)* — Full name
- `--notes <value>` — Notes about this person
- `--phone <value>` — Phone number
- `--relationship <value>` — Relationship to user (e.g. friend, colleague, client, mentor)
- `--website <value>` — Personal website

#### `sift people delete`
Delete a contact

**Arguments**

- `id` *(required)* — Person ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift people enrich`
Research public information about a person with replay-safe execution

**Arguments**

- `id` *(required)* — Person ID

**Flags**

- `--dataset <value>` — Optional dataset ID for a reviewable reconciliation plan
- `--dataset-upsert-by <value>` — Preferred dataset identity field
- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for exact retries
- `--mode <standard|ultra>` *(default: "standard")* — Research depth

#### `sift people get`
Get a person profile with traits and relationships

**Arguments**

- `id` *(required)* — Person ID

#### `sift people list`
List contacts

**Flags**

- `--category <family|romantic|professional|social>` — Relationship category
- `--contains <value>` — Name substring filter
- `--context <all|personal|work>` *(default: "all")* — Relationship context
- `--equals <value>` — Exact name filter
- `--has-no-email` — Only contacts without an email
- `--limit <value>` — Maximum number of results
- `--relationship <value>` — Filter by relationshipToUser
- `--starts-with <value>` — Name prefix filter

#### `sift people relate`
Create or update a relationship between two people

**Arguments**

- `personAId` *(required)* — First person ID
- `personBId` *(required)* — Second person ID

**Flags**

- `--dry-run` — Preview the relationship payload without writing
- `--notes <value>` — Relationship notes
- `--type <value>` *(required)* — Relationship type, e.g. colleague, sibling, spouse, collaborator
- `-y, --yes` — Apply without prompting

#### `sift people search`
Search contacts

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--contains <value>` — Name substring filter
- `--equals <value>` — Exact name filter
- `--has-no-email` — Only contacts without an email
- `--limit <value>` — Maximum number of results
- `--relationship <value>` — Filter by relationshipToUser
- `--starts-with <value>` — Name prefix filter

#### `sift people timeline`
List timeline facts connected to a person

**Arguments**

- `id` *(required)* — Person ID

**Flags**

- `--limit <value>` *(default: 50)* — Maximum facts to return
- `--order <asc|desc>` *(default: "asc")* — Sort order
- `--role <value>` — Filter by entity role, comma-separated

#### `sift people update`
Update a contact

**Arguments**

- `id` *(required)* — Person ID

**Flags**

- `--birth-year <value>` — Birth year
- `--birthday <value>` — Birthday (YYYY-MM-DD)
- `--company <value>` — Company name
- `--email <value>` — Email address
- `--estimated-age <value>` — Estimated age
- `--job-title <value>` — Job title
- `--linkedin-url <value>` — LinkedIn profile URL
- `--location <value>` — Location
- `--mbti <value>` — MBTI type (e.g. INTJ, ENFP)
- `--name <value>` — Full name
- `--notes <value>` — Notes about this person
- `--phone <value>` — Phone number
- `--relationship <value>` — Relationship to user
- `--website <value>` — Personal website


### Projects

Project management.

#### `sift projects archive`
Archive a project

**Arguments**

- `id` *(required)* — Project ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift projects context`
Get project context (tasks, notes, signals)

**Arguments**

- `id` *(required)* — Project ID

#### `sift projects create`
Create a project

**Flags**

- `--emoji <value>` — Single emoji
- `--name <value>` *(required)* — Project name
- `--status <planning|active|on_hold|blocked|completed>` — Project status
- `--summary <value>` — Project summary

#### `sift projects list`
List projects

**Flags**

- `--include-archived` — Include archived projects
- `--status <planning|active|on_hold|blocked|completed>` — Filter by status

#### `sift projects planning`
Get the canonical CSN planning snapshot for a project

**Arguments**

- `id` *(required)* — Project ID

#### `sift projects planning-recompute`
Recompute the canonical CSN planning snapshot for a project

**Arguments**

- `id` *(required)* — Project ID

#### `sift projects update`
Update a project

**Arguments**

- `id` *(required)* — Project ID

**Flags**

- `--emoji <value>` — Single emoji
- `--name <value>` — Project name
- `--status <planning|active|on_hold|blocked|completed>` — Project status
- `--summary <value>` — Project summary


### Recipes

Built-in research workflow recipes.

#### `sift recipes list`
List built-in research workflow recipes

#### `sift recipes show`
Show a built-in research workflow recipe

**Arguments**

- `id` *(required)* — Recipe ID


### Relationships

#### `sift relationships actions dry-run`
Preview a relationship action on the server without committing it

**Arguments**

- `id` *(required)* — Relationship action ID
- `entity` — Relationship entity as opportunity:<uuid> or prospect:<uuid>

**Flags**

- `--entity <value>` — Target as prospect:uuid or opportunity:uuid
- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for reproducible server-side previews
- `--input <value>` — Action input JSON object
- `--input-file <value>` — Path to action input JSON

#### `sift relationships actions list`
List registered relationship actions and their commitment policies

**Flags**

- `--approval-policy <value>` — Filter by approval policy
- `--commitment <value>` — Filter by commitment class
- `--limit <value>` — Maximum results

#### `sift relationships actions run`
Run any canonical relationship action with replay-safe caller identity

**Arguments**

- `id` *(required)* — Canonical action ID from relationships actions list
- `entity` — Relationship entity as opportunity:<uuid> or prospect:<uuid>

**Flags**

- `--entity <value>` — Target as prospect:uuid or opportunity:uuid
- `--expected-version <value>` — Current collaboration version
- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for exact retries
- `--input <value>` — Action input JSON object
- `--input-file <value>` — Path to an action input JSON file
- `--yes` — Confirm action execution

#### `sift relationships actions show`
Show one registered relationship action

**Arguments**

- `id` *(required)* — Relationship action ID

#### `sift relationships brief`
Compose an exact, evidence-grounded relationship brief

**Arguments**

- `subject` *(required)* — Subject as prospect:uuid or opportunity:uuid

**Flags**

- `--lens <value>` *(default: "relationship")* — Relationship lens identifier

#### `sift relationships composer approver-edit`
Create an attributed approver revision and reopen coaching review

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--body <value>` *(required)*
- `--expected-version <value>` *(required)*
- `--reason <value>` *(required)*
- `--subject <value>` *(required)*
- `--yes` — Confirm the attributed edit

#### `sift relationships composer bind-sender`
Bind an explicit active connected email account to a durable draft

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--expected-version <value>` *(required)* — Current optimistic session version
- `--sender <value>` *(required)* — Connected email account UUID

#### `sift relationships composer confirm`
Confirm the bound brief and create its first durable draft revision

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--expected-version <value>` *(required)* — Current optimistic session version
- `--yes` — Confirm brief and create draft

#### `sift relationships composer create`
Create or resume a durable relationship brief-to-draft session

**Arguments**

- `subject` *(required)* — Subject as prospect:uuid or opportunity:uuid

**Flags**

- `--file <value>` *(required)* — JSON file with source, recommendation, brief, and ranked evidence

#### `sift relationships composer dispatch`
Keep exact approval, send now, or schedule one governed relationship message

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--at <value>` — ISO-8601 time required for send_later
- `--choice <approve_only|send_now|send_later>` *(required)* — Dispatch outcome
- `--expected-version <value>` *(required)* — Current optimistic session version
- `--idempotency-key <value>` *(required)* — Stable retry key for this exact choice and time
- `--yes` — Confirm this governed dispatch choice

#### `sift relationships composer evaluate`
Evaluate the current durable draft and append phrase-anchored coaching findings

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--expected-version <value>` *(required)* — Current optimistic session version

#### `sift relationships composer finding-action`
Explain, preview, accept, reject, or undo an attributable coaching finding

**Arguments**

- `id` *(required)* — Composer session UUID
- `finding` *(required)* — Coaching finding UUID

**Flags**

- `--action <explain|preview|accept|reject|undo>` *(required)*
- `--expected-version <value>` *(required)* — Current optimistic session version
- `--yes` — Confirm a mutating coaching decision

#### `sift relationships composer history`
Show append-only coaching and draft decision history in recorded order

**Arguments**

- `id` *(required)* — Composer session UUID

#### `sift relationships composer request-approval`
Request or resume approval for the exact composer review; approval remains browser-only

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--expected-version <value>` *(required)* — Current optimistic session version
- `--idempotency-key <value>` *(required)* — Stable approval-request retry key
- `--yes` — Confirm the approval request

#### `sift relationships composer request-changes`
Return an exact review to its author without mutating the message

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--expected-version <value>` *(required)*
- `--reason <value>` *(required)*
- `--yes` — Confirm the review interruption

#### `sift relationships composer resolve-identity`
Resolve or route the inline plausible-duplicate gate for one reviewed message

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--candidate <value>` *(required)* — Candidate person UUID
- `--decision <same_person|different_people|route_to_owner>` *(required)*
- `--expected-version <value>` *(required)*
- `--yes` — Confirm the identity decision

#### `sift relationships composer review`
Continue a coaching-clear durable draft to governed review

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--approver-user-id <value>` — Optional active internal workspace member who will approve the exact message
- `--expected-version <value>` *(required)* — Current optimistic session version
- `--yes` — Confirm the transition to review

#### `sift relationships composer save-draft`
Save a new durable revision of a relationship draft

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--file <value>` *(required)* — JSON file with expectedVersion, subject, and bodyText

#### `sift relationships composer show`
Show a durable relationship composer session

**Arguments**

- `id` *(required)* — Composer session UUID

#### `sift relationships composer update`
Update bound intent and ranked evidence before draft creation

**Arguments**

- `id` *(required)* — Composer session UUID

**Flags**

- `--file <value>` *(required)* — JSON file with expectedVersion, brief, and evidence

#### `sift relationships contact-plan inspect`
Inspect one canonical person contact plan without mutating its source lifecycles

**Arguments**

- `person` *(required)* — Canonical person UUID

**Flags**

- `--from <value>` — Inclusive ISO-8601 inspection window start
- `--limit <value>` *(default: 100)* — Maximum projected items
- `--timezone <value>` — IANA display timezone
- `--to <value>` — Inclusive ISO-8601 inspection window end

#### `sift relationships diagnoses create`
Create an immutable, evidence-grounded relationship diagnosis snapshot

**Flags**

- `--file <value>` *(required)* — Diagnosis JSON file
- `--yes` — Confirm immutable diagnosis creation

#### `sift relationships diagnoses list`
List immutable relationship diagnosis snapshots

**Flags**

- `--limit <value>`
- `--subject-id <value>`
- `--subject-type <prospect|opportunity>`

#### `sift relationships email-accounts list`
List sender accounts available to relationship drafts and governed sends

#### `sift relationships generated-assets draft`
Create a private communication proposal from an approved outreach asset; does not send

**Arguments**

- `id` *(required)* — Generated outreach/follow-up asset UUID

**Flags**

- `--file <value>` *(required)* — Exact senderAccountId, destination, optional edits, and idempotency JSON file
- `--yes` — Confirm proposal creation

#### `sift relationships generated-assets generate`
Generate a grounded asset from approved exact playbook and source-asset versions

**Flags**

- `--file <value>` *(required)* — Generation request JSON file
- `--yes` — Confirm immutable asset generation

#### `sift relationships generated-assets list`
List generated relationship assets with manifests and latest artifact review

**Flags**

- `--limit <value>`
- `--subject-id <value>`
- `--subject-type <prospect|opportunity>`

#### `sift relationships generated-assets review`
Append a human approval decision to a generated artifact

**Arguments**

- `id` *(required)* — Generated asset UUID

**Flags**

- `--decision <approved|rejected|needs_changes>` *(required)*
- `--reason <value>` *(required)*
- `--yes` — Confirm append-only review

#### `sift relationships generated-assets review-history`
List the append-only review history for one generated asset

**Arguments**

- `id` *(required)* — Generated asset UUID

#### `sift relationships generated-assets show`
Show one generated asset, exact manifest, and latest artifact approval

**Arguments**

- `id` *(required)* — Generated asset UUID

#### `sift relationships generated-assets usage-list`
List append-only usage and outcome links for one generated asset

**Arguments**

- `id` *(required)* — Generated asset UUID

#### `sift relationships generated-assets usage-record`
Append an export, internal-share, or outcome-link record to a generated asset

**Arguments**

- `id` *(required)* — Generated asset UUID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character retry key
- `--kind <exported|shared_internally|outcome_linked>` *(required)*
- `--outcome <value>` — Stable outcome reference; required for outcome_linked
- `--yes` — Confirm append-only usage record

#### `sift relationships handoffs list`
List immutable relationship outcome receipts in the onboarding queue

**Flags**

- `--limit <value>` *(default: 100)* — Maximum receipts

#### `sift relationships handoffs show`
Show one immutable relationship outcome handoff receipt

**Arguments**

- `id` *(required)* — Outcome handoff receipt UUID

#### `sift relationships meetings brief create`
Compose a cited meeting brief from approved relationship evidence

**Flags**

- `--input <value>` — Exact meeting brief input JSON
- `--input-file <value>` — Path to exact meeting brief input JSON

#### `sift relationships meetings brief show`
Read the current cited meeting brief by recomposing its exact inputs

**Flags**

- `--input <value>` — Exact owner, subject, approved asset, and optional meeting JSON
- `--input-file <value>` — Path to exact meeting brief input JSON

#### `sift relationships meetings evidence capture`
Capture consent-gated transcript evidence or explicitly declared manual notes

**Flags**

- `--idempotency-key <value>` *(required)* — Caller-owned stable key for exact retries
- `--input <value>` — Exact meeting evidence input JSON
- `--input-file <value>` — Path to exact meeting evidence input JSON
- `--yes` — Confirm canonical evidence capture

#### `sift relationships meetings evidence show`
Inspect one canonical meeting-evidence event and its source locators

**Arguments**

- `id` *(required)* — Relationship meeting evidence event UUID

#### `sift relationships meetings proposals apply`
Atomically apply one approved meeting proposal after fresh precondition checks

**Arguments**

- `id` *(required)* — Approved meeting proposal UUID

**Flags**

- `--expected-proposal-digest <value>` *(required)* — Exact reviewed proposal digest
- `--yes` — Confirm the persistent internal relationship-state change

#### `sift relationships meetings proposals create`
Create an immutable, evidence-cited proposal for one registered relationship action

**Flags**

- `--idempotency-key <value>` *(required)* — Caller-owned stable key for exact retries
- `--input <value>` — Exact meeting proposal input JSON
- `--input-file <value>` — Path to exact meeting proposal input JSON
- `--yes` — Confirm immutable proposal creation

#### `sift relationships meetings proposals list`
List meeting-derived relationship proposals and their review lifecycle

**Flags**

- `--status <pending|approved|rejected|committed|failed|stale>` — Filter by lifecycle status
- `--subject-id <value>` — Filter by subject UUID
- `--subject-kind <prospect|opportunity>` — Filter by subject kind

#### `sift relationships meetings proposals review`
Append an attributable approval or rejection to one unchanged meeting proposal

**Arguments**

- `id` *(required)* — Meeting proposal UUID

**Flags**

- `--input <value>` — Exact decision, reason, and expectedProposalDigest JSON
- `--input-file <value>` — Path to exact proposal review input JSON
- `--yes` — Confirm attributable proposal review

#### `sift relationships meetings proposals show`
Inspect a meeting-derived relationship proposal, evidence, diffs, and recovery plan

**Arguments**

- `id` *(required)* — Meeting proposal UUID

#### `sift relationships outcomes describe`
Describe the runtime relationship-outcome contracts and safety boundaries

#### `sift relationships outcomes inspect`
Inspect declared relationship outcomes in Answer/C0 mode without persistence

**Flags**

- `--input <value>` — Exact InspectRelationshipOutcomeInput JSON
- `--input-file <value>` — Path to exact inspection input JSON

#### `sift relationships outcomes interventions`
Show the single bounded, reviewable intervention batch for a snapshot

**Arguments**

- `snapshotId` *(required)* — Relationship-outcome snapshot ID

#### `sift relationships outcomes list`
List relationship-outcome snapshots with bounded cursor pagination

**Flags**

- `--cursor <value>` — Opaque cursor from the previous page
- `--limit <value>` *(default: 50)* — Maximum snapshots to return
- `--projection <sales_forecast|onboarding_handoff>` — Filter by projection
- `--scope-anchor-id <value>` — Filter by declared scope anchor ID
- `--scope-anchor-kind <value>` — Filter by declared scope anchor kind

#### `sift relationships outcomes records`
List exact snapshot records with bounded cursor pagination

**Arguments**

- `snapshotId` *(required)* — Relationship-outcome snapshot ID

**Flags**

- `--cursor <value>` — Opaque cursor from the previous page
- `--limit <value>` *(default: 50)* — Maximum records to return
- `--posture <value>` — Filter by the declared record posture
- `--risk <value>` — Filter by low, moderate, high, or unknown operational risk

#### `sift relationships outcomes review`
Record an idempotent snapshot review without executing any proposed registered action

**Arguments**

- `snapshotId` *(required)* — Relationship-outcome snapshot ID

**Flags**

- `--dry-run` — Validate authority and selected interventions without recording a review
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for this exact review
- `--input <value>` — Exact ReviewRelationshipOutcomeSnapshotInput JSON (idempotency is injected)
- `--input-file <value>` — Path to exact snapshot review input JSON
- `--yes` — Confirm append-only review recording

#### `sift relationships outcomes run`
Create or dry-run a C2 relationship-outcome snapshot; never execute proposed actions

**Flags**

- `--dry-run` — Validate and project without persisting a snapshot
- `--idempotency-key <value>` *(required)* — Caller-owned stable key for this exact snapshot request
- `--input <value>` — Exact CreateRelationshipOutcomeSnapshotInput JSON (idempotency is injected)
- `--input-file <value>` — Path to exact snapshot input JSON
- `--yes` — Confirm C2 snapshot persistence

#### `sift relationships outcomes show`
Show one immutable relationship-outcome snapshot

**Arguments**

- `snapshotId` *(required)* — Relationship-outcome snapshot ID

#### `sift relationships playbook-recommendations create`
Record a consequential recommendation with at least three plausible moves

**Flags**

- `--file <value>` *(required)* — Recommendation JSON file
- `--yes` — Confirm immutable recommendation creation

#### `sift relationships playbook-recommendations list`
List recorded relationship playbook recommendations with alternative moves

**Flags**

- `--limit <value>`
- `--subject-id <value>`
- `--subject-type <prospect|opportunity>`

#### `sift relationships playbooks create`
Create an immutable, unapproved relationship playbook version from runtime-contract JSON

**Flags**

- `--file <value>` *(required)* — Playbook version JSON file
- `--yes` — Confirm immutable version creation

#### `sift relationships playbooks list`
List immutable relationship playbook versions and latest approval decisions

**Flags**

- `--limit <value>` — Maximum versions
- `--stable-key <value>` — Filter by stable playbook key

#### `sift relationships playbooks review`
Append a human approval decision to a playbook version

**Arguments**

- `id` *(required)* — Playbook version UUID

**Flags**

- `--decision <approved|rejected|needs_changes>` *(required)*
- `--reason <value>` *(required)* — Attributable review reason
- `--yes` — Confirm append-only review

#### `sift relationships playbooks show`
Show one immutable relationship playbook version and latest approval

**Arguments**

- `id` *(required)* — Playbook version UUID

#### `sift relationships proposals get`
Inspect one relationship action proposal and its evidence

**Arguments**

- `id` *(required)* — Proposal ID

#### `sift relationships proposals list`
List pending and historical relationship action proposals

**Flags**

- `--enrollment <value>` — Filter by enrollment ID
- `--limit <value>` — Maximum results
- `--sequence <value>` — Filter by sequence ID
- `--status <value>` — Filter by proposal status

#### `sift relationships proposals request-approval`
Request short-lived human approval for a proposal; cannot approve or consume it

**Arguments**

- `id` *(required)* — Proposal ID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries
- `--purpose <value>` — Non-secret reason shown to the human approver

#### `sift relationships queues list`
List relationship team queues in the active workspace

#### `sift relationships recommendations execute`
Execute an accepted, current recommendation through the canonical action runtime

**Arguments**

- `id` *(required)* — Recommendation UUID

**Flags**

- `--yes` — Confirm canonical action execution

#### `sift relationships recommendations list`
List immutable relationship recommendation snapshots

**Flags**

- `--lens <value>` — Relationship lens identifier
- `--limit <value>` *(default: 50)* — Maximum recommendations
- `--subject <value>` — Filter by prospect:uuid or opportunity:uuid

#### `sift relationships recommendations review`
Append an ordinary review decision to a relationship recommendation

**Arguments**

- `id` *(required)* — Recommendation UUID

**Flags**

- `--decision <accepted|dismissed|snoozed|needs_information>` *(required)* — Review decision
- `--reason <value>` — Review reason
- `--snoozed-until <value>` — Offset-aware ISO date-time, required for snoozed
- `--yes` — Confirm the append-only review

#### `sift relationships recommendations show`
Show a relationship recommendation with its exact citations and gates

**Arguments**

- `id` *(required)* — Recommendation UUID

#### `sift relationships sequences create`
Create a supervised relationship sequence from a JSON definition

**Flags**

- `--definition <value>` — Sequence definition JSON object
- `--definition-file <value>` — Path to sequence definition JSON
- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries

#### `sift relationships sequences dry-run`
Preview a supervised sequence on the server without committing it

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for reproducible server-side previews
- `--input <value>` — Dry-run input JSON object
- `--input-file <value>` — Path to dry-run input JSON

#### `sift relationships sequences enroll`
Enroll a relationship target in a supervised sequence

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries
- `--input <value>` — Enrollment input JSON object
- `--input-file <value>` — Path to enrollment input JSON

#### `sift relationships sequences get`
Show one supervised relationship sequence

**Arguments**

- `id` *(required)* — Sequence ID

#### `sift relationships sequences list`
List supervised relationship sequences

**Flags**

- `--limit <value>` — Maximum results
- `--status <value>` — Filter by sequence status

#### `sift relationships sequences pause`
Pause a supervised relationship sequence

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries
- `--reason <value>` — Non-secret pause reason

#### `sift relationships sequences resume`
Resume a supervised relationship sequence

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries

#### `sift relationships sequences runs`
List execution evidence for a supervised relationship sequence

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--limit <value>` — Maximum results
- `--status <value>` — Filter by run status

#### `sift relationships sequences update`
Update a supervised relationship sequence from a JSON definition

**Arguments**

- `id` *(required)* — Sequence ID

**Flags**

- `--definition <value>` — Sequence update JSON object
- `--definition-file <value>` — Path to sequence update JSON
- `--idempotency-key <value>` *(required)* — Stable 8-128 character key for safe retries

#### `sift relationships show`
Show the current relationship collaboration snapshot

**Arguments**

- `entity` *(required)* — Relationship entity as opportunity:<uuid> or prospect:<uuid>

#### `sift relationships source-assets create`
Create an immutable, unapproved grounded source-asset version

**Flags**

- `--file <value>` *(required)* — Source-asset version JSON file
- `--yes` — Confirm immutable version creation

#### `sift relationships source-assets list`
List immutable grounded source-asset versions and latest approval decisions

**Flags**

- `--limit <value>` — Maximum versions
- `--stable-key <value>` — Filter by stable source-asset key

#### `sift relationships source-assets review`
Append a human approval decision to a source-asset version

**Arguments**

- `id` *(required)* — Source-asset version UUID

**Flags**

- `--decision <approved|rejected|needs_changes>` *(required)*
- `--reason <value>` *(required)*
- `--yes` — Confirm append-only review

#### `sift relationships source-assets show`
Show one exact immutable source-asset version and its latest review

**Arguments**

- `id` *(required)* — Source-asset version UUID


### Research

Research workflow planning and orchestration.

#### `sift research init`
Create a research project and standard datasets

**Arguments**

- `name` *(required)* — Research project name

**Flags**

- `--dry-run` — Preview project/dataset creation without writing
- `--template <historical-research>` *(default: "historical-research")* — Research template
- `--yes` — Confirm creation without prompting

#### `sift research plan`
Plan a deterministic research workflow before writing data

**Arguments**

- `goal` *(required)* — Research goal

**Flags**

- `--project <value>` — Existing project ID
- `--source-dataset <value>` — Existing sources dataset ID

#### `sift research run`
Create deterministic agent work for a research recipe

**Arguments**

- `recipe` *(required)* — Research run recipe

**Flags**

- `--agent <value>` *(default: "researcher")* — Assigned agent alias
- `--context <value>` — Additional input context JSON object
- `--context-file <value>` — Additional input context JSON file
- `--dry-run` — Preview work item payload without writing
- `--project <value>` — Project ID
- `--source-dataset <value>` — Source dataset ID
- `--yes` — Confirm work item creation without prompting

#### `sift research status`
Inspect research project context and CLI readiness

**Arguments**

- `project` — Project ID


### Skills

Installable Siftable skillpacks.

#### `sift skills install`
Install a Siftable skillpack into a local skills directory

**Arguments**

- `id` *(required)* — Skillpack ID

**Flags**

- `--force` — Replace an existing installed skill
- `--target <value>` *(default: "skills")* — Installed skills directory
- `-y, --yes` — Confirm replacing an existing skill

#### `sift skills list`
List installable Siftable skillpacks


### Tasks

Human planning tasks.

#### `sift tasks bulk-delete`
Preview or bulk-delete tasks

**Flags**

- `--confirm` — Execute deletion instead of preview
- `--done` — Filter by completed state
- `--ids <value>` — Comma-separated task IDs
- `--phase <draft|open|in_flight|review|blocked|done|cancelled>`
- `--title-contains <value>` — Title substring filter
- `--title-equals <value>` — Exact title filter
- `--title-starts-with <value>` — Title prefix filter
- `--when <now|today|soon|later>`

#### `sift tasks complete`
Mark a task as complete

**Arguments**

- `id` *(required)* — Task ID

#### `sift tasks coupling-create`
Create a CSN coupling edge between tasks in the same project

**Arguments**

- `id` *(required)* — Source task ID
- `target` *(required)* — Target task ID

**Flags**

- `--note <value>` — Optional note
- `--strength <value>` — Coupling strength (0-1)
- `--type <info|resource>` *(required)* — Coupling type

#### `sift tasks coupling-delete`
Delete a CSN coupling edge from a task

**Arguments**

- `id` *(required)* — Task ID
- `edgeId` *(required)* — Coupling edge ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift tasks coupling-list`
List CSN coupling edges for a task

**Arguments**

- `id` *(required)* — Task ID

#### `sift tasks create`
Create a human planning task

**Flags**

- `--acceptance-criteria <value>` — Acceptance criteria (semicolon-separated text, e.g. "tests pass; docs updated")
- `--description <value>` — Task description
- `--due <value>` — Due date (ISO 8601)
- `--effort <trivial|small|medium|large|epic|unknown>` — Effort estimate
- `--phase <draft|open|in_flight|review|blocked|done|cancelled>` — Lifecycle phase
- `--priority <do_now|schedule|delegate|someday>` — Priority level
- `--project <value>` — Project ID
- `--scope <value>` — Scope boundaries (JSON object with include/exclude arrays)
- `--title <value>` *(required)* — Task title

#### `sift tasks delete`
Delete a task

**Arguments**

- `id` *(required)* — Task ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift tasks get`
Get human planning task details

**Arguments**

- `id` *(required)* — Task ID

#### `sift tasks list`
List human planning tasks

**Flags**

- `--cursor <value>` — Continuation cursor from a previous page
- `--effort <trivial|small|medium|large|epic|unknown>` — Filter by effort
- `--limit <value>` *(default: 25)* — Maximum number of results
- `--phase <draft|open|in_flight|review|blocked|done|cancelled>` — Filter by phase
- `--project <value>` — Filter by project ID
- `--status <inbox|next_action|in_progress|waiting_for|completed|archived>` — Filter by status
- `--title-contains <value>` — Title substring filter
- `--title-equals <value>` — Exact title filter
- `--title-starts-with <value>` — Title prefix filter

#### `sift tasks planning-update`
Update CSN planning fields for a task

**Arguments**

- `id` *(required)* — Task ID

**Flags**

- `--cynefin-confidence <value>` — Cynefin confidence (0-1)
- `--cynefin-domain <clear|complicated|complex|chaotic|aporetic>` — Cynefin domain
- `--cynefin-rationale <value>` — Why this domain fits
- `--cynefin-source <user|assistant|classifier>` — Source of the planning classification
- `--duration-model <value>` — Duration model JSON, e.g. {"kind":"point","days":2}
- `--reversibility <value>` — Reversibility score (0-1)

#### `sift tasks update`
Update a human planning task

**Arguments**

- `id` *(required)* — Task ID

**Flags**

- `--acceptance-criteria <value>` — Acceptance criteria (semicolon-separated text, e.g. "tests pass; docs updated")
- `--blocked-reason <value>` — Reason task is blocked
- `--description <value>` — Task description
- `--due <value>` — Due date (ISO 8601)
- `--effort <trivial|small|medium|large|epic|unknown>` — Effort estimate
- `--phase <draft|open|in_flight|review|blocked|done|cancelled>` — Lifecycle phase
- `--priority <do_now|schedule|delegate|someday>` — Priority level
- `--project <value>` — Project ID
- `--scope <value>` — Scope boundaries (JSON object with include/exclude arrays)
- `--status <inbox|next_action|in_progress|waiting_for|completed|archived>` — Task status
- `--title <value>` — Task title


### Timeline

Timeline facts and narratives.

#### `sift timeline create`
Create a user-authored timeline fact

**Flags**

- `--body <value>` — Fact body or notes
- `--confidence <low|medium|high>` — Confidence level
- `--entity <value>` *(repeatable)* — Participant/entity as type:uuid or type:uuid:role; repeatable
- `--fact-type <value>` *(default: "event")* — Fact type
- `--precision <millisecond|minute|hour|day|month|year|decade|century|millennium|mega_year|era>` *(default: "year")* — Temporal precision
- `--source-label <value>` — Source/provenance label
- `--source-note <value>` — Source/provenance note
- `--source-url <value>` — Source/provenance URL
- `--timestamp <value>` — ISO timestamp
- `--title <value>` *(required)* — Fact title
- `--visibility <org_public|private|restricted>` — Timeline visibility
- `--year <value>` — Historical year CE
- `--year-end <value>` — Historical end year CE

#### `sift timeline delete`
Retract a timeline fact

**Arguments**

- `id` *(required)* — Timeline fact ID

**Flags**

- `--yes` — Confirm retraction without prompting

#### `sift timeline list`
List timeline facts with bounded filters

**Flags**

- `--cursor <value>` — Pagination cursor
- `--end <value>` — End boundary, ISO timestamp or supported historical boundary
- `--entity <value>` — Entity filter as type:uuid
- `--entity-role <value>` — Comma-separated entity roles
- `--fact-types <value>` — Comma-separated fact types
- `--limit <value>` *(default: 50)* — Maximum items to return
- `--order <asc|desc>` *(default: "asc")* — Sort order
- `--q <value>` — Text search query
- `--source-types <value>` — Comma-separated source types
- `--start <value>` — Start boundary, ISO timestamp or supported historical boundary

#### `sift timeline narrative`
Generate a narrative summary or explanation for timeline facts

**Flags**

- `--action <summarize|changed_since|led_to|what_next|cross_object>` *(default: "summarize")* — Narrative action
- `--entity <value>` — Entity scope as type:uuid
- `--entity-roles <value>` — Comma-separated entity roles
- `--fact-type <value>` — Fact type filter
- `--limit <value>` *(default: 60)* — Maximum timeline facts to include
- `--participant <value>` — Participant filter as type:uuid
- `--prompt <value>` — Question or custom narrative prompt
- `--q <value>` — Text query filter
- `--related-entity <value>` — Related entity as type:uuid
- `--source-type <value>` — Source type filter


### Vault

Vault metadata and governed destination-bound materialization.

#### `sift vault audit`
List Vault audit events (requires vault:audit:read)

**Flags**

- `--limit <value>` — Maximum number of results
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault create`
Store a new encrypted secret (requires vault:manage)

**Flags**

- `--category <value>` — Category
- `--description <value>` — Description
- `--name <value>` *(required)* — Secret name
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--payload <value>` *(required)* — JSON payload to encrypt
- `--slug <value>` — Machine-friendly identifier
- `--tags <value>` — Comma-separated tags
- `--type <env_var|credential|oauth_token|ssh_key|certificate|note>` — Entry type
- `--url <value>` — Associated URL

#### `sift vault leases clean`
*Alias: `sift env leases clean`*
Clean one local lease artifact and attest confirmed, failed, or unknowable state

**Arguments**

- `id` *(required)*

**Flags**

- `--checkout-root <value>` — Git checkout used to prove runtime separation
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault leases list`
*Alias: `sift env leases list`*
List value-free environment lease and cleanup metadata

**Flags**

- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault leases revoke`
*Alias: `sift env leases revoke`*
Revoke future lease use, remove the local artifact when present, and attest cleanup

**Arguments**

- `id` *(required)*

**Flags**

- `--checkout-root <value>` — Git checkout used to prove runtime separation
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault leases status`
*Alias: `sift env leases status`*
Inspect one value-free environment lease lifecycle

**Arguments**

- `id` *(required)*

**Flags**

- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault list`
List vault entries (metadata only; requires vault:metadata:read)

**Flags**

- `--category <value>` — Filter by category
- `--limit <value>` — Maximum number of results
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--type <env_var|credential|oauth_token|ssh_key|certificate|note>` — Filter by entry type

#### `sift vault materialize environment`
Pull one exact governed Vault bundle into a Sift-managed development environment file

**Flags**

- `--approval-timeout <value>` *(default: 600)*
- `--checkout-root <value>` — Checkout containing .sift/environment.yaml
- `--destination <value>` — Exact relative destination when the manifest declares more than one bundle
- `--endpoint-class <development|production|ci|shared_host|policy_ineligible>` *(required)* — Explicit endpoint policy class; managed pulls accept development only
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--purpose <value>` *(required)*
- `--replace` — Replace a changed Sift-managed file using its exact observed precondition

#### `sift vault materialize request`
Request human approval for one destination-bound Vault materialization

**Flags**

- `--destination <value>` *(required)*
- `--entry <value>` *(required)*
- `--expected-digest <value>`
- `--field <value>` *(required)*
- `--materializer-digest <value>` *(required)*
- `--mode <0400|0600>` *(default: "0600")*
- `--nonce <value>` *(required)*
- `--overwrite`
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--purpose <value>` *(required)*
- `--runner-fingerprint <value>` *(required)*
- `--runner-public-key <value>` *(required)*
- `--tracked-exception`
- `--workspace-root <value>` — Absolute local workspace root containing the destination

#### `sift vault materialize revoke`
Revoke a pending destination-bound Vault materialization

**Arguments**

- `id` *(required)* — Materialization ID

**Flags**

- `--legacy-context` — Use the Personal/v0 identity of a request created with the deprecated path-shaped --workspace alias
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault materialize run`
Request approval, wait, and materialize one Vault field at the exact approved path

**Flags**

- `--approval-timeout <value>` *(default: 600)*
- `--destination <value>` *(required)* — Destination path; relative paths resolve inside --workspace-root before approval
- `--entry <value>` *(required)*
- `--field <value>` *(required)*
- `--mode <0400|0600>` *(default: "0600")*
- `--overwrite`
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--purpose <value>` *(required)*
- `--tracked-exception`
- `--workspace-root <value>` — Absolute local workspace root containing the destination

#### `sift vault materialize status`
Inspect safe status for a destination-bound Vault materialization

**Arguments**

- `id` *(required)*

**Flags**

- `--legacy-context` — Use the Personal/v0 identity of a request created with the deprecated path-shaped --workspace alias
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault search`
Search Vault entry metadata (exact safe field names resolve during materialization; values are never returned)

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--limit <value>` — Maximum number of results
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>

#### `sift vault update`
Update vault entry metadata (requires vault:manage)

**Arguments**

- `id` *(required)* — Vault entry ID

**Flags**

- `--category <value>` — Category
- `--description <value>` — Description
- `--name <value>` — Entry name
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--tags <value>` — Comma-separated tags
- `--url <value>` — Associated URL

#### `sift vault use lease`
*Alias: `sift env lease`*
Create one exact short-lived environment bundle artifact outside the Git worktree

**Flags**

- `--approval-timeout <value>` *(default: 600)*
- `--checkout-root <value>` — Checkout containing .sift/environment.yaml
- `--consumer <value>` *(required)* — Bound consumer identifier; not a command allowlist
- `--consumer-pid <value>` — Optional already-running consumer process lifetime
- `--destination <value>` — Manifest destination used only to select one exact bundle
- `--endpoint-class <development|production|ci|shared_host>` *(required)*
- `--holder <value>` — Bound holder identifier; defaults to the local runner fingerprint
- `--owner <value>` — Exact Vault owner: personal or workspace:<tenant-id>
- `--purpose <value>` *(required)*
- `--ttl <value>` *(default: 300)*


### Work

Executable agent work queue.

#### `sift work a2a cancel`
Cancel the remote conversation; worker termination remains unconfirmed

**Arguments**

- `connection` *(required)* — A2A connection ID
- `dispatch` *(required)* — Outbound dispatch ID

#### `sift work a2a continue`
Send one explicit clarification to a waiting A2A conversation

**Arguments**

- `connection` *(required)* — A2A connection ID
- `dispatch` *(required)* — Outbound dispatch ID

**Flags**

- `--request-key <value>` *(required)* — Stable key to reuse when retrying this operation
- `--text <value>` *(required)* — Clarification text to send on this conversation

#### `sift work a2a recover`
Recover an addressed blocked dispatch after repairing authority

**Arguments**

- `connection` *(required)* — A2A connection ID
- `dispatch` *(required)* — Outbound dispatch ID

**Flags**

- `--generation <value>` *(required)* — Observed dispatch generation

#### `sift work a2a review`
Inspect scoped A2A dispatch history, artifacts and verification

**Arguments**

- `id` *(required)* — Local work item ID

#### `sift work a2a run`
Run or poll an addressed outbound A2A dispatch

**Arguments**

- `connection` *(required)* — A2A connection ID
- `dispatch` *(required)* — Outbound dispatch ID

#### `sift work a2a send`
Send one bounded assignment to an explicit A2A connection and remote work item

**Arguments**

- `connection` *(required)* — A2A connection ID
- `work` *(required)* — Local work item ID that holds the assignment and review

**Flags**

- `--deadline <value>` *(required)* — Absolute ISO deadline for this conversation
- `--max-turns <value>` *(default: 8)* — Maximum outgoing sends in this conversation, including the opening
- `--remote-work <value>` *(required)* — Remote work item UUID the receiver re-authorizes
- `--remote-workspace <value>` — Remote workspace UUID; omit for personal scope
- `--request-key <value>` *(required)* — Stable key to reuse when retrying this assignment
- `--text <value>` *(required)* — Assignment text to send to the remote agent

#### `sift work a2a status`
Read an addressed outbound A2A dispatch

**Arguments**

- `connection` *(required)* — A2A connection ID
- `dispatch` *(required)* — Outbound dispatch ID

#### `sift work answer`
Answer a question a running agent asked. Opens the web app, where you answer with your signed-in session, then waits for the stored outcome.

**Arguments**

- `id` *(required)* — Work item UUID
- `requestId` — Runtime request UUID (default: the only open question)

**Flags**

- `--app-url <value>` — Web app origin for the decision page (default: SIFT_APP_URL, else derived from --api-url)
- `--full-detail` — Print the whole stored request text instead of a 500-character preview
- `--no-browser` — Print the decision URL instead of opening it
- `--poll-ms <value>` *(default: 2000)*
- `--timeout <value>` *(default: 900)* — Seconds to wait for the decision

#### `sift work approve`
Decide an approval a running agent is waiting on. Opens the web app, where you decide with your signed-in session, then waits for the stored outcome.

**Arguments**

- `id` *(required)* — Work item UUID
- `requestId` — Runtime request UUID (default: the only open approval)

**Flags**

- `--app-url <value>` — Web app origin for the decision page (default: SIFT_APP_URL, else derived from --api-url)
- `--full-detail` — Print the whole stored request text instead of a 500-character preview
- `--no-browser` — Print the decision URL instead of opening it
- `--poll-ms <value>` *(default: 2000)*
- `--timeout <value>` *(default: 900)* — Seconds to wait for the decision

#### `sift work attach`
Attach to a running work item: show its state and recent ledger, follow it, and (on a terminal) send typed lines as instructions

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--after-sequence <value>` — Follow from after this ledger sequence instead of the current end
- `--backlog <value>` *(default: 20)* — Replay this many ledger events before the current end
- `--full-detail` — Print the whole stored request text instead of a 500-character preview
- `--keep-following` — Keep following after the live execution attempt ends
- `--once` — Print the current state (and backlog) once, then exit
- `--timeout <value>` *(default: 0)* — Stop following after this many seconds (0 = no limit)
- `--wait-ms <value>` *(default: 10000)* — Long-poll window per ledger request; runtime requests and controls refresh after each window

#### `sift work block`
Mark a work item as blocked

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work cancel`
Cancel queued/blocked work; active work requires --owner and --claim-token

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work claim`
Claim the next available executable agent work item

**Arguments**

- `id` — Optional specific work item ID

**Flags**

- `--agent <value>` — Agent alias to claim for
- `--lease <value>` *(default: 1800)* — Lease seconds
- `--owner <value>` *(required)* — Claim owner identity

#### `sift work collaboration acknowledge`
Advance a named mailbox cursor through one exact, durably processed sequence

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--consumer-key <value>` *(required)* — Stable non-secret key naming this durable event consumer
- `--last-sequence <value>` *(required)* — Exact highest contiguous sequence durably processed by this consumer

#### `sift work collaboration events`
List ordered mailbox events without advancing any durable cursor

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--after-sequence <value>` — Return events after this exact sequence
- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--for-me` — Return room-wide messages and those addressed to you, skipping your own; resume or acknowledge from nextSequence, which covers skipped events
- `--limit <value>` — Maximum events to return

#### `sift work collaboration participant add`
Add a contributor, reviewer, or observer to a work-item mailbox

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--agent-alias-id <value>` — Agent alias UUID represented by the participant
- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--idempotency-key <value>` *(required)* — Caller-owned stable 8-128 character key for exact retries
- `--participant-user-id <value>` *(required)* — User UUID represented by the participant
- `--role <contributor|reviewer|observer>` *(required)* — Participant role

#### `sift work collaboration participant remove`
Remove an assignable participant from a work-item mailbox

**Arguments**

- `id` *(required)* — Work item UUID
- `participantId` *(required)* — Collaboration participant UUID

**Flags**

- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--idempotency-key <value>` *(required)* — Caller-owned stable 8-128 character key for exact retries

#### `sift work collaboration participants`
List the durable collaboration participants for a work item

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)

#### `sift work collaboration send`
Append a retry-safe message or artifact event to a work-item mailbox

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--idempotency-key <value>` *(required)* — Caller-owned stable 8-128 character key for exact retries
- `--kind <message|artifact_published>` *(default: "message")* — Client event kind
- `--parts <value>` — Exact collaboration event parts as a JSON array
- `--reply-to-event-id <value>` — Existing event UUID this event replies to
- `--supersedes-event-id <value>` — Caller-authored event UUID this event supersedes
- `--text <value>` — Convenience text part; cannot be combined with --parts
- `--to <value>` *(repeatable)* — Address an active participant by participant UUID, actor UUID, or exact label (any case). Omit to address the whole room; addressing grants no authority

#### `sift work collaboration wait`
Wait for mailbox events at least once; never acknowledges them automatically

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--after-sequence <value>` — Override cursor resume and wait after this sequence
- `--as-agent-id <value>` — Agent alias UUID to use as the collaboration actor (or set SIFT_AGENT_ALIAS_ID)
- `--consumer-key <value>` *(required)* — Stable non-secret key naming this durable event consumer
- `--for-me` — Return room-wide messages and those addressed to you, skipping your own; acknowledge nextSequence, which covers skipped events
- `--limit <value>` — Maximum events to return
- `--wait-ms <value>` — Long-poll duration in milliseconds

#### `sift work complete`
Approve and complete an executable agent work item

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work contract check`
Deterministically validate a Work Contract V1 file or fetched work item

**Arguments**

- `id` — Work item ID to fetch and validate

**Flags**

- `--file <value>` — Path to a Work Contract V1 JSON file

#### `sift work coverage-shadow`
Post the test cases a work item's verification plan runs, for Jev coverage shadow evaluation

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--commit <value>` — Commit to read test files at (default: HEAD of this checkout)
- `--dry-run` — Print the candidate summary and payload size without posting
- `--save <value>` — Also write the built payload as JSON to this file (with or without --dry-run)

#### `sift work create`
Create an executable agent work item

**Flags**

- `--acceptance-criteria <value>` — Acceptance criteria JSON array or semicolon-separated text
- `--agent <value>` — Assigned agent alias
- `--allow-deploy` — Allow deployment in the authored contract
- `--allow-migrate` — Allow migrations in the authored contract
- `--allow-network` — Allow network access in the authored contract
- `--allow-vault` — Allow audited Vault access in the authored contract
- `--allowed-actions <value>` — Allowed actions JSON object
- `--capture-applicability <conversational_capture_required|non_conversational|unclassified>` — Prospective capture applicability; this does not determine study eligibility
- `--capture-receipt <value>` *(repeatable)* — Finalized capture receipt UUID to bind atomically; repeat for multi-surface handoffs
- `--context <value>` — Input context JSON object
- `--contract <value>` — Complete Work Contract V1 JSON
- `--contract-file <value>` — Path to a complete Work Contract V1 JSON file
- `--depends-on <value>` — Dependency JSON array: [{"workItemId":"<uuid>","requiredGate"?:"done"|"commands_passed"}]
- `--dry-run` — Preview the normalized payload and contract without creating work
- `--exclude-scope <value>` *(repeatable)* — Excluded workspace-relative write scope; repeat for multiple paths
- `--profile <coding|read-only|read_only>` — Author a complete Work Contract V1 using the coding or read-only profile
- `--project <value>` — Linked project ID
- `--prompt <value>` — Agent prompt or instructions
- `--rank <value>` *(default: 0)* — Queue rank
- `--scope <value>` *(repeatable)* — Included workspace-relative write scope; repeat for multiple paths
- `--task <value>` — Parent human planning task ID
- `--title <value>` *(required)* — Executable work item title
- `--verify <value>` — Verification commands separated by semicolons
- `--write-scope <value>` — Write scope JSON object

#### `sift work dependencies get`
Get authoritative dependencies and claimability for a work item

**Arguments**

- `id` *(required)* — Work item UUID

#### `sift work dependencies set`
Atomically replace the authoritative dependencies for a work item

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--depends-on <value>` *(required)* — Dependency JSON array; pass [] to clear dependencies

#### `sift work dependency-policy get`
Get a project default work-dependency gate

**Flags**

- `--project <value>` *(required)* — Project UUID

#### `sift work dependency-policy set`
Set a project default work-dependency gate

**Flags**

- `--gate <done|commands_passed>` *(required)* — Default gate for dependencies that omit requiredGate
- `--project <value>` *(required)* — Project UUID

#### `sift work edit`
C2: Revise queued, unclaimed work while preserving its UUID and dependency edges. Do not use after claim or execution; wait for a queued unclaimed state or create follow-up work. Example: raise queue rank or refine acceptance criteria while the item is queued and unclaimed. Counterexample: do not change status, dependencies, or an active worker lease with this capability. Execution-contract edits supersede the active verification plan and reset verification evidence; queue-rank-only edits do not. The same Idempotency-Key and payload replays the original receipt; a different payload with that key is rejected.

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--acceptance-criteria <value>` — Replacement acceptance criteria JSON array
- `--allowed-actions <value>` — Replacement allowed actions JSON object
- `--context <value>` — Replacement input context JSON object
- `--contract <value>` — Replacement Work Contract V1 JSON
- `--contract-file <value>` — Path to replacement Work Contract V1 JSON
- `--dry-run` — Show normalized diff and proof consequences without mutating
- `--expected-revision <value>` *(required)* — Observed work item revision
- `--idempotency-key <value>` *(required)* — Stable retry key for this exact edit
- `--patch <value>` — Editable fields as one JSON object
- `--patch-file <value>` — Path to an editable-fields JSON object
- `--prompt <value>` — Replacement prompt; use --patch for null
- `--rank <value>` — Replacement queue rank
- `--reason <value>` *(required)* — Auditable reason for the revision
- `--title <value>` — Replacement title
- `--verify <value>` — Replacement verification commands as JSON array or semicolon-separated text
- `--write-scope <value>` — Replacement write scope JSON object

#### `sift work fail`
Mark a work item as failed

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work get`
Get executable agent work item details

**Arguments**

- `id` *(required)* — Work item ID

#### `sift work heartbeat`
Extend a work item lease

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work interrupt`
Interrupt the current turn of a running work item; the session stays open for further instructions

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--idempotency-key <value>` — Retry key (1-128 of A-Z a-z 0-9 . _ : -). Default: a new key per invocation, reused for its own retries
- `--poll-ms <value>` *(default: 1000)*
- `--retries <value>` *(default: 2)* — Retries after a transport error, 408, 429 or 5xx, with the same key
- `--retry-delay-ms <value>` *(default: 500)*
- `--timeout <value>` *(default: 120)* — Seconds to wait with --wait
- `--wait` — Wait until the server records a final state for the control

#### `sift work list`
List executable agent work items

**Flags**

- `--agent <value>` — Filter by assigned agent alias
- `--limit <value>` *(default: 50)* — Maximum results
- `--project <value>` — Filter by project ID
- `--status <value>` — Filter by status
- `--task <value>` — Filter by parent human planning task ID

#### `sift work release`
Release a claimed work item back to the queue

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work requeue`
Return blocked work to the queue for a fresh claim

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work review`
Mark executable agent work as needing human review

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work revisions`
List immutable, attributable work-item revision receipts and field diffs

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--limit <value>` *(default: 50)* — Maximum revisions to return

#### `sift work send`
Queue a follow-up instruction for a running work item; it runs as the next turn after the current turn settles

**Arguments**

- `id` *(required)* — Work item UUID
- `instruction` *(required)* — Instruction text, or - to read it from stdin

**Flags**

- `--idempotency-key <value>` — Retry key (1-128 of A-Z a-z 0-9 . _ : -). Default: a new key per invocation, reused for its own retries
- `--poll-ms <value>` *(default: 1000)*
- `--retries <value>` *(default: 2)* — Retries after a transport error, 408, 429 or 5xx, with the same key
- `--retry-delay-ms <value>` *(default: 500)*
- `--timeout <value>` *(default: 120)* — Seconds to wait with --wait
- `--wait` — Wait until the server records a final state for the control

#### `sift work start`
Mark a work item as running

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--memory-decision <value>` — Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work verification evidence`
Submit externally executed evidence for an exact plan version and step ID

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact reference JSON array for larger logs
- `--attempt <value>` *(required)* — Caller-stable attempt identity
- `--claim-owner <value>` — Active lease owner for workspace-service evidence
- `--claim-token <value>` — Opaque active lease token for workspace-service evidence
- `--environment <value>` *(required)* — Execution environment label
- `--exit-code <value>` — Process exit code when applicable
- `--outcome <passed|failed|error>` *(required)* — Attempt outcome
- `--output <value>` — Bounded output excerpt; secrets are redacted by the API
- `--plan-version <value>` *(required)* — Active verification plan version
- `--provenance <value>` — Evidence provenance JSON object
- `--ran-at <value>` — RFC3339 execution timestamp
- `--step <value>` *(required)* — Stable verification step UUID

#### `sift work verification history`
List immutable verification-plan history and coverage

**Arguments**

- `id` *(required)* — Work item ID

#### `sift work verification plan`
Show the active versioned verification plan and coverage

**Arguments**

- `id` *(required)* — Work item ID

#### `sift work verification revise`
Create an audited active verification-plan revision

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--expected-version <value>` *(required)* — Observed active plan version
- `--provenance <value>` — Revision provenance JSON object
- `--reason <value>` *(required)* — Audited revision reason
- `--steps <value>` — Verification step JSON array
- `--steps-file <value>` — Path to a verification step JSON array
- `--yes` — Confirm activation without prompting

#### `sift work verify`
Deprecated compatibility command. Hosted LLM verification is retired; use verification-command evidence.

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--history` — List historical verifier runs recorded before retirement
- `--model <value>` — Deprecated; ignored because hosted verification is retired
- `--reps <value>` — Deprecated; ignored because hosted verification is retired

#### `sift work watch`
Follow a running work item: ledger events, the execution attempt, runtime requests and controls. Read-only.

**Arguments**

- `id` *(required)* — Work item UUID

**Flags**

- `--after-sequence <value>` — Follow from after this ledger sequence instead of the current end
- `--backlog <value>` *(default: 0)* — Replay this many ledger events before the current end
- `--full-detail` — Print the whole stored request text instead of a 500-character preview
- `--keep-following` — Keep following after the live execution attempt ends
- `--once` — Print the current state (and backlog) once, then exit
- `--timeout <value>` *(default: 0)* — Stop following after this many seconds (0 = no limit)
- `--wait-ms <value>` *(default: 10000)* — Long-poll window per ledger request; runtime requests and controls refresh after each window


### Worker

Local executable work runners.

#### `sift worker dispatch`
Build a no-spend, surface-neutral plan for exactly two AWS agent workers

**Flags**

- `--max-runtime-minutes <value>` *(default: 120)* — Per-worker runtime ceiling
- `--source-sha <value>` — Reviewed 40-character source Git SHA; defaults to a clean current HEAD
- `--surface <cli|t3|codex|claude-code|mcp>` *(default: "cli")* — Calling control surface; does not change dispatch identity
- `--work-item <value>` *(required; repeatable)* — Queued Sift work-item UUID; repeat exactly twice

#### `sift worker listen`
Receive reviewed mobile launches on a host-configured local worker

**Flags**

- `--agent-alias-id <value>` — Agent alias UUID for this runner; defaults to the credential binding
- `--arg <value>` *(default: []; repeatable)* — Fixed executable argument (repeatable)
- `--checkpoint-arg <value>` *(default: []; repeatable)* — Fixed checkpoint argument (repeatable)
- `--checkpoint-executable <value>` — Optional host-approved checkpoint executable
- `--cwd <value>` *(required)* — Host-approved working directory
- `--executable <value>` *(required)* — Host-approved executable; receives work JSON on stdin
- `--name <value>` *(required)* — Runner name shown on the phone
- `--once` — Register and poll once, then exit
- `--receipts <value>` *(required)* — Durable local receipt directory
- `--runner <value>` *(required)* — Stable runner UUID

#### `sift worker run`
Claim executable work, run a local worker command, and report needs-review artifacts

**Flags**

- `--agent <value>` *(required)* — Agent alias to claim work for
- `--command <value>` *(required)* — Local command to run for the claimed work item
- `--cwd <value>` — Fallback working directory for the local command
- `--lease <value>` *(default: 1800)* — Lease seconds
- `--owner <value>` *(required)* — Worker owner fingerprint


### Workspaces

#### `sift workspaces current`
Show the current Personal or collaborative workspace selection

#### `sift workspaces list`
List collaborative workspaces available to the authenticated user

#### `sift workspaces use`
Select a collaborative workspace for discovery, or Personal to clear it

**Arguments**

- `id` *(required)* — Workspace ID, or "personal"
