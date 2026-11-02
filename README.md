<p align="center"><strong>Siftable CLI</strong> is the command-line interface to <a href="https://siftable.io">Siftable</a> — your tasks, agent work queues, knowledge, calendar, people, and code intelligence, scriptable from the shell.</p>

<br/>

If you want Siftable inside your editor or coding agent (Claude, Cursor, other MCP clients), use the <a href="https://www.npmjs.com/package/@siftable/mcp-server"><strong>Siftable MCP server</strong></a>.
<br/>If you want the web app, go to <a href="https://siftable.io">siftable.io</a>.

## Quickstart

### Installing the CLI

There's one package on the npm registry — install it with whatever you use:

```bash
# Run directly, no install
npx @siftable/cli <command>

# Install globally
npm install  -g @siftable/cli     # npm
bun  install -g @siftable/cli     # bun
pnpm add     -g @siftable/cli     # pnpm
```

Then run `sift` to get started. The binary installs as `sift`, with `siftable` and the `exf` compatibility alias. Full install notes live at [siftable.io/docs.html#cli-install](https://siftable.io/docs.html#cli-install).

### Authenticating

```bash
sift auth login
```

Or set a Personal Access Token directly:

```bash
export SIFT_TOKEN=sift_pat_your_token_here
```

### Your first commands

```bash
sift tasks list
sift tasks create --title "Ship CLI v1"
sift notes search "deployment process"
sift work list --agent codex --json
```

### Local Taster review

Taster reviews committed changes in a Git checkout using your existing Codex login:

```bash
sift review --repo /path/to/checkout --expected-head <full-commit-sha> \
  --base origin/main --receipt /tmp/taster-receipt.json
```

`--repo` defaults to the current directory. `--workspace` selects a Siftable organization;
repository paths belong in `--repo`. `--expected-head` fails before inference if the selected
checkout has a different committed HEAD. Uncommitted changes are disclosed but not reviewed.

Taster checks the selected Codex executable's version and required local CLI capabilities
before starting the pre-pass or model work. Use `--codex-bin /absolute/path/to/codex` to choose
another executable. This check does not establish that your account can use the requested model.

`--receipt` saves three private local files: the existing revision-bound receipt, a complete
`<receipt>.report.json` companion containing findings, source evidence, scope exclusions,
runtime identity and budgets, and a `<receipt>.attempt.json` lifecycle record. Use `--report`
to override the companion path or save a full report without a receipt file. The attempt is
written before setup; setup failures keep unresolved revisions null. Interruptions after
revision resolution produce a failed receipt and report. Completion describes the stated
review scope and does not establish that the code is correct.

The default whole-review deadline is 30 minutes, including setup and the pre-pass; set
`--deadline-ms` to change it. The existing per-call timeout and model-call ceiling still apply.
A timeout or interruption stops owned processes and retains a non-clean outcome. Exit codes
are 0 for clean/advisory-only, 1 for blocking findings, 2 for incomplete/skipped/failed,
130 for SIGINT, and 143 for SIGTERM. Full reports can contain private repository source;
choose which artifacts to share with your team.

### The interactive copilot

```bash
sift interactive
```

A terminal copilot that acts on your filesystem and the Siftable work graph. It requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`); the command tells you if Bun isn't installed.

Performance-critical paths (context compaction, long-thread memory, filesystem scanning, merge orchestration) run through native [Zig](https://ziglang.org) modules loaded via Bun FFI. The published package ships prebuilt libraries for **macOS (Apple Silicon)** and **Linux (x64)**, which get the fast native path by default. Every native module has a lockstep TypeScript fallback, so other platforms still work — just without the native acceleration.

## Mental model

Users plan commitments with `sift tasks`. Agents execute bounded queue items with `sift work`. User-visible executor identities, aliases, capabilities, and default permissions live under `sift agents`.

- **`sift tasks`** — human planning: outcomes, priority, acceptance criteria, project linkage, and human approval.
- **`sift work`** — executable agent packets: claim leases, assigned aliases, write scope, verification commands, artifacts, and review state.

Link the two with `sift work create --task <task-id>` rather than assigning an executor directly to a task.

## Commands

The most-used surface, grouped by domain. Run `sift --help` or `sift <topic> --help` for the complete set (including `datasets`, `graph`, `timeline`, `research`, and `evidence`).

<details>
<summary><strong>Full command reference</strong></summary>

### Auth
| Command | Description |
|---------|-------------|
| `sift auth login` | Authenticate with Siftable |
| `sift auth logout` | Clear stored credentials |
| `sift auth status` | Show current auth status |

### Tasks
| Command | Description |
|---------|-------------|
| `sift tasks list` | List human planning tasks (filterable by status, project) |
| `sift tasks get <id>` | Get human planning task details |
| `sift tasks create` | Create a human planning task |
| `sift tasks update <id>` | Update a human planning task |
| `sift tasks complete <id>` | Mark a human planning task complete |
| `sift tasks delete <id>` | Delete a human planning task |

### Work
| Command | Description |
|---------|-------------|
| `sift work list` | List executable agent work queue items |
| `sift work create` | Create a bounded executable agent work item |
| `sift work claim` | Claim queued executable work with a lease |
| `sift work start <id>` | Mark claimed work as running |
| `sift work heartbeat <id>` | Extend a claim lease |
| `sift work block <id>` | Mark work blocked |
| `sift work review <id>` | Mark work as needing review |
| `sift work complete <id>` | Approve and complete work with summary/artifacts |
| `sift work fail <id>` | Mark work failed |
| `sift work release <id>` | Release a claim back to the queue |
| `sift work cancel <id>` | Cancel work |
| `sift work watch <id>` | Follow a running work item's ledger, attempt, requests and controls |
| `sift work attach <id>` | Show recent state, follow, and send typed lines as instructions |
| `sift work send <id> <text>` | Queue a follow-up instruction for the running agent |
| `sift work interrupt <id>` | Interrupt the agent's current turn |
| `sift work approve <id>` / `answer <id>` | Decide an agent request in the web app and wait for the outcome |

### Agents
| Command | Description |
|---------|-------------|
| `sift agents list` | List user-visible agent aliases |
| `sift agents get <alias>` | Get alias capabilities and permissions |
| `sift agents create` | Create an agent alias |
| `sift agents update <alias>` | Update alias metadata |
| `sift agents disable <alias>` | Disable an alias without deleting history |
| `sift agents work <alias>` | List executable work assigned to an alias |

### Projects
| Command | Description |
|---------|-------------|
| `sift projects list` | List projects |
| `sift projects create` | Create a project |
| `sift projects update <id>` | Update a project |
| `sift projects archive <id>` | Archive a project |
| `sift projects context <id>` | Get full project context |

### Notes
| Command | Description |
|---------|-------------|
| `sift notes list` | List notes |
| `sift notes get <id>` | Get note with full content |
| `sift notes create` | Create a note |
| `sift notes search <query>` | Search knowledge base |
| `sift notes update <id>` | Update a note |
| `sift notes delete <id>` | Delete a note |

### Calendar
| Command | Description |
|---------|-------------|
| `sift calendar list` | List events (filterable by date range) |
| `sift calendar create` | Create an event |
| `sift calendar update <id>` | Update an event |
| `sift calendar delete <id>` | Delete an event |

### People
| Command | Description |
|---------|-------------|
| `sift people list` | List contacts |
| `sift people search <query>` | Search contacts |

### Code tools
| Command | Description |
|---------|-------------|
| `sift code blame <file>` | Git blame for a file |
| `sift code link <task>` | Link a task to code |
| `sift code memory store` | Store a curated code fact |
| `sift code memory list` | List stored facts |
| `sift code memory search <query>` | Search stored facts |
| `sift code memory delete <id>` | Delete a stored fact |

Use Git, `rg`, the editor, or agent-native tools for source inspection and search
inside an authorized checkout. The CLI no longer indexes or semantically searches
repository source.

### Vault

For managed `.env` files, prefer the contract flow: commit `.sift/environment.yaml`, keep the destination ignored, and let a human or agent run `sift env pull` when the environment is needed. Pull is demand-triggered rather than polled in the background. Use `sift vault materialize run` for an a la carte field. For an explicitly local-authoritative dotenv source, use the reviewed `sift env push plan` / `sift env push apply` flow; a pull-managed destination cannot be pushed back blindly.

| Command | Description |
|---------|-------------|
| `sift vault list` | List vault entries (metadata only) |
| `sift vault create` | Store an encrypted secret |
| `sift vault search <query>` | Search vault entries |
| `sift vault materialize run` | Request approval and write one Vault field to one exact local destination |
| `sift vault materialize environment` | Materialize one declared environment bundle (same governed flow as `sift env pull`) |
| `sift vault update <id>` | Update entry metadata |

### Environment contracts

| Command | Description |
|---------|-------------|
| `sift env check` | Validate `.sift/environment.yaml` offline without reading values |
| `sift env diff` | Show value-free contract and checkout-safety drift |
| `sift env example` | Generate a deterministic names-and-placeholders-only `.env.example` |
| `sift env push plan` | Create a value-free plan for an explicitly named local-authoritative dotenv source |
| `sift env push apply` | Apply one exact reviewed dotenv push plan atomically |
| `sift env import plan`, `sift env import apply` | Compatibility spellings for the reviewed push flow |
| `sift env pull` | Pull one approved Vault bundle into its declared development environment file |
| `sift env status` | Report value-free managed environment state and freshness |
| `sift env rm` | Remove one exact recognized Sift-managed local environment file |

### Documents
| Command | Description |
|---------|-------------|
| `sift documents upload <file>` | Upload a document (PDF, MD, TXT) as a note |

### Codex automation
| Command | Description |
|---------|-------------|
| `sift codex daily-review collect --json` | Collect read-only Siftable and local git context for daily Codex reviews |

</details>

## Scripting

Every command supports `--json` for structured output, so the CLI composes with other tools:

```bash
# List tasks as JSON and filter with jq
sift tasks list --json | jq '.tasks[] | select(.status == "in_progress")'

# Create a human planning task and capture the ID
TASK_ID=$(sift tasks create --title "Deploy v2" --json | jq -r '.task.id')

# Create executable agent work linked to the human task
sift work create --task "$TASK_ID" --agent codex --title "Implement Deploy v2" --verify "npm run build;npm test"

# Use in CI/CD scripts
export SIFT_TOKEN=sift_pat_...
sift tasks complete "$TASK_ID"
```

## Configuration

Global flags (each maps to an environment variable where noted):

| Flag | Env var | Description |
|------|---------|-------------|
| `--token` | `SIFT_TOKEN` | Personal access token |
| `--api-url` | `SIFT_API_URL` | API base URL (default: `https://siftable.io`) |
| `--json` | — | Output raw JSON instead of tables |
| `--no-input` | — | Disable interactive prompts |

Other environment variables:

| Variable | Description |
|----------|-------------|
| `SIFT_TOKEN` | Personal access token for authentication |
| `SIFT_API_URL` | API base URL (default: `https://siftable.io`) |
| `SIFT_WORKSPACE_ID` | Workspace org ID to scope operations |

Legacy `EXF_TOKEN`, `EXF_API_URL`, `EXF_WORKSPACE_ID`, and `exf_pat_` tokens remain supported while older automation configs migrate.

## Docs

- [**CLI reference**](./docs/cli.md) — every command and flag, with conventions and scripting
- [**Interactive copilot**](./docs/interactive.md) — the `sift interactive` TUI in full
- [**Siftable docs**](https://siftable.io/docs.html) — the same docs, published online
- [**Siftable MCP server**](https://www.npmjs.com/package/@siftable/mcp-server) — editor and agent integration
- [**Issues & source**](https://github.com/Tom-R-Main/Siftable-CLI)

## License

MIT — see [LICENSE](./LICENSE).
