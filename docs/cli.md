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
- **Raw Vault reads are retired.** `sift vault read` returns migration guidance without requesting plaintext.

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
sift tasks list --json | jq '.[] | select(.status == "in_progress")'

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

---

## Command reference

All 201 commands, grouped by topic. Every command also accepts the [global flags](#global-flags) (`--json`, `--token`, `--api-url`, `--workspace`, `--no-input`).

**Topics:** [General](#general) · [AI](#ai) · [Agents](#agents) · [Approvals](#approvals) · [Auth](#auth) · [Billing](#billing) · [Calendar](#calendar) · [Capabilities](#capabilities) · [Code](#code) · [Codebase](#codebase) · [Codex](#codex) · [Datasets](#datasets) · [Documents](#documents) · [Events](#events) · [Evidence](#evidence) · [Grants](#grants) · [Graph](#graph) · [Notes](#notes) · [Organizations](#organizations) · [People](#people) · [Projects](#projects) · [Recipes](#recipes) · [Research](#research) · [Skills](#skills) · [Tasks](#tasks) · [Timeline](#timeline) · [Vault](#vault) · [Work](#work) · [Worker](#worker)


### General

Top-level commands and diagnostics.

#### `sift capabilities`
Show Siftable CLI capabilities and readiness status

#### `sift codebase`
*Alias: `sift codebase index`*
Index a codebase (scan and upload files)

**Arguments**

- `id` — Repository ID

**Flags**

- `--exclude <value>` — Comma-separated exclude glob patterns
- `--include <value>` — Comma-separated include glob patterns
- `--incremental` — Git-aware incremental index (changed files only)
- `--path <value>` — Absolute path to repository root

#### `sift commands`
Show agent-friendly command topics and workflow entry points

#### `sift doctor`
Diagnose local Siftable CLI configuration without printing secrets

#### `sift interactive`
Launch the Siftable terminal copilot (sift interactive) — an in-process AI assistant over your tasks, work, calendar, projects, and people.

**Flags**

- `--connected-models` — List eligible connected models and exit
- `--connection <value>` — Select a Model Connection UUID for a gateway invocation
- `--max-output-tokens <value>` — Maximum connected-model output tokens (1-32768)
- `--model <value>` — Select an eligible connected model for a gateway invocation
- `--prompt <value>` — Invoke the selected connected model once and exit

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


### AI

Connected-model discovery, invocation, status, and usage. These commands expose only non-secret connection metadata and use explicit incremental device scopes.

#### `sift ai invoke`
Invoke an eligible connected model (requires `ai:invoke` and `ai:connections:use`)

**Flags**

- `--connection <value>` *(required)* — Model Connection UUID returned by `sift ai list`
- `--max-output-tokens <value>` — Maximum output tokens (1-32768)
- `--model <value>` *(required)* — Eligible model ID returned by `sift ai list`
- `--prompt <value>` *(required)* — Prompt text

#### `sift ai list`
List eligible connected models (requires `ai:models:read`)

#### `sift ai status [connection]`
Show non-secret Model Connection status (requires `ai:connections:use`)

**Arguments**

- `connection` — Optional Model Connection UUID

#### `sift ai usage`
Show connected-model usage totals (requires `ai:usage:read`)

**Flags**

- `--from <value>` — ISO-8601 period start
- `--to <value>` — ISO-8601 period end


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

- `--scope <ai:models:read|ai:invoke|ai:usage:read|ai:connections:use|vault:metadata:read|vault:manage|vault:audit:read>` *(repeatable)* — Incremental AI invocation or Vault scope to request; management AI scopes and plaintext reveal are unavailable

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

#### `sift code expertise`
Refresh developer expertise index for a repository

**Arguments**

- `repo` *(required)* — Repository ID

#### `sift code history`
Get commit history for a repository

**Arguments**

- `repo` *(required)* — Repository ID

**Flags**

- `--limit <value>` — Maximum number of results
- `--path <value>` — Filter by file path

#### `sift code link`
Link a task to code (file, commit, or repository)

**Arguments**

- `task-id` *(required)* — Task ID

**Flags**

- `--commit <value>` — Commit SHA
- `--file <value>` — File path
- `--notes <value>` — Notes about the link
- `--repo <value>` *(required)* — Repository ID

#### `sift code memory delete`
Delete a stored codebase fact

**Arguments**

- `id` *(required)* — Memory ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift code memory list`
List stored codebase facts

**Flags**

- `--limit <value>` — Maximum number of results
- `--repo <value>` — Repository ID

#### `sift code memory search`
Search stored codebase facts

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--category <architecture|integration|convention|entrypoint|gotcha|ownership>` — Filter by category
- `--limit <value>` — Maximum number of results
- `--repo <value>` — Repository ID

#### `sift code memory store`
Store a codebase fact

**Flags**

- `--category <architecture|integration|convention|entrypoint|gotcha|ownership>` *(required)* — Fact category
- `--fact <value>` *(required)* — Fact to store (1-2 sentences)
- `--file <value>` — Related file path
- `--repo <value>` — Repository ID

#### `sift code who-knows`
Find experts for a code area

**Arguments**

- `repo` *(required)* — Repository ID
- `area` *(required)* — Path, glob, or symbol

**Flags**

- `--limit <value>` — Maximum number of results


### Codebase

Code indexing and search.

#### `sift codebase delete`
Delete a repository and all indexed data

**Arguments**

- `id` *(required)* — Repository ID

**Flags**

- `-y, --yes` — Skip confirmation

#### `sift codebase incremental`
*Alias: `sift codebase incremental-index`, `sift codebase index-incremental`*
Incrementally index a codebase using git-aware changed files

**Arguments**

- `id` *(required)* — Repository ID

**Flags**

- `--exclude <value>` — Comma-separated exclude glob patterns
- `--include <value>` — Comma-separated include glob patterns
- `--path <value>` *(required)* — Absolute path to repository root

#### `sift codebase list`
List indexed repositories

#### `sift codebase register`
Register a codebase for indexing

**Flags**

- `--auto-index` — Enable automatic indexing
- `--name <value>` *(required)* — Repository name
- `--path <value>` *(required)* — Absolute path to repository root
- `--project <value>` — Project ID to associate

#### `sift codebase search`
Semantic code search

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--language <value>` — Filter by language
- `--limit <value>` — Maximum number of results
- `--project <value>` — Project ID
- `--repo <value>` — Repository ID
- `--symbol-type <function|class|interface|type|export|impl>` — Filter by symbol type

#### `sift codebase snapshot`
Get latest index snapshot for a repository

**Arguments**

- `id` *(required)* — Repository ID

**Flags**

- `--branch <value>` — Filter by branch
- `--materialize` — Generate a download URL for the snapshot

#### `sift codebase status`
Check indexing status for a repository

**Arguments**

- `id` *(required)* — Repository ID


### Codex

Codex automation helpers.

#### `sift codex daily-review collect`
Collect read-only Siftable and local git context for Codex daily work reviews

**Flags**

- `--calendar-days <value>` *(default: 7)* — Calendar lookahead days
- `--limit <value>` *(default: 20)* — Maximum records per source
- `--skip-git` — Skip local git summary


### Datasets

Structured datasets.

#### `sift datasets add`
Add records to a dataset

**Arguments**

- `id` *(required)* — Dataset ID

**Flags**

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

- `--adapter <github_gh|terraform_apply>` *(required)*
- `--approval-timeout <value>` *(default: 600)*
- `--audience <value>` *(required)*
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

#### `sift people create`
Create a contact

**Flags**

- `--birth-year <value>` — Birth year
- `--birthday <value>` — Birthday (YYYY-MM-DD)
- `--company <value>` — Company name (auto-links to organization if exists)
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

#### `sift people get`
Get a person profile with traits and relationships

**Arguments**

- `id` *(required)* — Person ID

#### `sift people graph`
Show a person-centered relationship graph

**Arguments**

- `id` *(required)* — Person ID

**Flags**

- `--depth <value>` *(default: 2)* — Relationship graph depth
- `--include-inactive` — Include inactive relationship edges

#### `sift people kinship`
Explain kinship or relationship distance between two people

**Arguments**

- `egoPersonId` *(required)* — Ego/source person ID
- `targetPersonId` *(required)* — Target person ID

**Flags**

- `--max-depth <value>` *(default: 6)* — Maximum relationship depth

#### `sift people list`
List contacts

**Flags**

- `--contains <value>` — Name substring filter
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

- `--effort <trivial|small|medium|large|epic|unknown>` — Filter by effort
- `--limit <value>` — Maximum number of results
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

Secrets vault.

#### `sift vault audit`
List Vault audit events (requires vault:audit:read)

**Flags**

- `--limit <value>` — Maximum number of results

#### `sift vault create`
Store a new encrypted secret (requires vault:manage)

**Flags**

- `--category <value>` — Category
- `--description <value>` — Description
- `--name <value>` *(required)* — Secret name
- `--payload <value>` *(required)* — JSON payload to encrypt
- `--slug <value>` — Machine-friendly identifier
- `--tags <value>` — Comma-separated tags
- `--type <env_var|credential|oauth_token|ssh_key|certificate|note>` — Entry type
- `--url <value>` — Associated URL

#### `sift vault list`
List vault entries (metadata only; requires vault:metadata:read)

**Flags**

- `--category <value>` — Filter by category
- `--limit <value>` — Maximum number of results
- `--type <env_var|credential|oauth_token|ssh_key|certificate|note>` — Filter by entry type

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
- `--purpose <value>` *(required)*
- `--runner-fingerprint <value>` *(required)*
- `--runner-public-key <value>` *(required)*
- `--tracked-exception`

#### `sift vault materialize run`
Request approval, wait, and materialize one Vault field at the exact approved path

**Flags**

- `--approval-timeout <value>` *(default: 600)*
- `--destination <value>` *(required)*
- `--entry <value>` *(required)*
- `--field <value>` *(required)*
- `--mode <0400|0600>` *(default: "0600")*
- `--overwrite`
- `--purpose <value>` *(required)*
- `--tracked-exception`

#### `sift vault materialize status`
Inspect safe status for a destination-bound Vault materialization

**Arguments**

- `id` *(required)*

#### `sift vault read`
Retired: Vault plaintext reveal is unavailable from the CLI

**Arguments**

- `id` *(required)* — Vault entry ID

#### `sift vault search`
Search vault entries (metadata only; requires vault:metadata:read)

**Arguments**

- `query` *(required)* — Search query

**Flags**

- `--limit <value>` — Maximum number of results

#### `sift vault update`
Update vault entry metadata (requires vault:manage)

**Arguments**

- `id` *(required)* — Vault entry ID

**Flags**

- `--category <value>` — Category
- `--description <value>` — Description
- `--name <value>` — Entry name
- `--tags <value>` — Comma-separated tags
- `--url <value>` — Associated URL


### Work

Executable agent work queue.

#### `sift work block`
Mark a work item as blocked

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
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

#### `sift work complete`
Approve and complete an executable agent work item

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work create`
Create an executable agent work item

**Flags**

- `--acceptance-criteria <value>` — Acceptance criteria JSON array or semicolon-separated text
- `--agent <value>` — Assigned agent alias
- `--allowed-actions <value>` — Allowed actions JSON object
- `--context <value>` — Input context JSON object
- `--depends-on <value>` — Dependency JSON array: [{"workItemId":"<uuid>","requiredGate"?:"done"|"commands_passed"|"verified"}]
- `--project <value>` — Linked project ID
- `--prompt <value>` — Agent prompt or instructions
- `--rank <value>` *(default: 0)* — Queue rank
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

- `--gate <done|commands_passed|verified>` *(required)* — Default gate for dependencies that omit requiredGate
- `--project <value>` *(required)* — Project UUID

#### `sift work fail`
Mark a work item as failed

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
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
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work list`
List executable agent work items

**Flags**

- `--agent <value>` — Filter by assigned agent alias
- `--limit <value>` — Maximum results
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
- `--owner <value>` — Claim owner identity (required for lease-owned transitions)
- `--reason <value>` — Block or failure reason
- `--summary <value>` — Result summary
- `--verification-results <value>` — Verification evidence JSON array: [{"command","exitCode","output"?}]

#### `sift work start`
Mark a work item as running

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--artifacts <value>` — Artifact refs JSON array
- `--claim-token <value>` — Claim token returned by work claim (required for lease-owned transitions)
- `--lease <value>` — Lease seconds
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
Run the LLM verifier against a work item's acceptance criteria and record a verifier run. Promotion to verified requires passing verification-command evidence plus a verified verdict.

**Arguments**

- `id` *(required)* — Work item ID

**Flags**

- `--history` — List prior verifier runs instead of running a new one
- `--model <value>` — Verifier model override
- `--reps <value>` — Repeated evaluations per criterion (1-8, default 3)


### Worker

Local executable work runners.

#### `sift worker run`
Claim executable work, run a local worker command, and report needs-review artifacts

**Flags**

- `--agent <value>` *(required)* — Agent alias to claim work for
- `--command <value>` *(required)* — Local command to run for the claimed work item
- `--cwd <value>` — Fallback working directory for the local command
- `--lease <value>` *(default: 1800)* — Lease seconds
- `--owner <value>` *(required)* — Worker owner fingerprint
