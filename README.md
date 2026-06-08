# @siftable/cli

Command-line interface for [Siftable](https://siftable.io) — an automation harness for human planning tasks, executable agent work queues, calendar, knowledge, code indexing, and CRM.

Source: [github.com/Tom-R-Main/Siftable-CLI](https://github.com/Tom-R-Main/Siftable-CLI)

## Installation

There's one package on the npm registry — install it with whatever you use:

```bash
# Run directly, no install
npx @siftable/cli <command>

# Install globally
npm install  -g @siftable/cli     # npm
bun  install -g @siftable/cli     # bun
pnpm add     -g @siftable/cli     # pnpm
```

This gives you the `sift` command (plus `siftable` and the `exf` compatibility alias).

## Quick Start

### 1. Authenticate

```bash
sift auth login
```

Or set a Personal Access Token directly:

```bash
export SIFT_TOKEN=sift_pat_your_token_here
```

### 2. Run your first command

```bash
sift tasks list
sift tasks create --title "Ship CLI v1"
sift notes search "deployment process"
sift work list --agent codex --json
```

## Mental Model

Users plan commitments with `sift tasks`. Agents execute bounded queue items with `sift work`. User-visible executor identities, aliases, capabilities, and default permissions live under `sift agents`.

`sift tasks` is for human planning: outcomes, priority, acceptance criteria, project linkage, and human approval. `sift work` is for executable agent packets: claim leases, assigned aliases, write scope, verification commands, artifacts, and review state. Link them with `sift work create --task <task-id>` instead of assigning an executor directly to a task.

`sift` is the primary command. `siftable` is an explicit product alias, and `exf` remains as a compatibility alias for older automations.

## Interactive Copilot (`sift interactive`)

```bash
sift interactive
```

A terminal copilot that acts on your filesystem and the Siftable work graph. It
requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`); the
command will tell you if Bun isn't installed.

Performance-critical paths (context compaction, long-thread memory, filesystem
scanning, merge orchestration) run through native [Zig](https://ziglang.org)
modules loaded via Bun FFI. The published package ships prebuilt libraries for
**macOS (Apple Silicon)** and **Linux (x64)** — those platforms get the fast
native path by default. Every native module has a lockstep TypeScript fallback,
so other platforms still work, just without the native acceleration.

## Command Reference

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

### Agents
| Command | Description |
|---------|-------------|
| `sift agents list` | List user-visible agent aliases |
| `sift agents get <alias>` | Get alias capabilities and permissions |
| `sift agents create` | Create an agent alias |
| `sift agents update <alias>` | Update alias metadata |
| `sift agents disable <alias>` | Disable an alias without deleting history |
| `sift agents work <alias>` | List executable work assigned to an alias |

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

### Codex Automation
| Command | Description |
|---------|-------------|
| `sift codex daily-review collect --json` | Collect read-only Siftable and local git context for daily Codex reviews |

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

### Vault
| Command | Description |
|---------|-------------|
| `sift vault list` | List vault entries (metadata only) |
| `sift vault create` | Store an encrypted secret |
| `sift vault read <id>` | Decrypt and read a secret |
| `sift vault search <query>` | Search vault entries |
| `sift vault update <id>` | Update entry metadata |

### Codebase
| Command | Description |
|---------|-------------|
| `sift codebase list` | List indexed repositories |
| `sift codebase register` | Register a repo for indexing |
| `sift codebase status <id>` | Check indexing status |
| `sift codebase index <id>` | Trigger indexing |
| `sift codebase search <query> [--repo <id>\|--project <id>]` | Semantic code search scoped to the current registered repo by default |
| `sift codebase snapshot <id>` | Get latest snapshot |
| `sift codebase delete <id>` | Delete a repository |

### Code Tools
| Command | Description |
|---------|-------------|
| `sift code history <repo>` | Get commit history |
| `sift code who-knows <repo> <area>` | Find experts for a code area |
| `sift code blame <file>` | Git blame for a file |
| `sift code link <task>` | Link a task to code |
| `sift code expertise <repo>` | Refresh expertise index |
| `sift code memory store` | Store a codebase fact |
| `sift code memory list` | List stored facts |
| `sift code memory search <query>` | Search stored facts |
| `sift code memory delete <id>` | Delete a stored fact |

### Documents
| Command | Description |
|---------|-------------|
| `sift documents upload <file>` | Upload a document (PDF, MD, TXT) as a note |

## Global Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `--token` | `SIFT_TOKEN` | Personal access token |
| `--api-url` | `SIFT_API_URL` | API base URL (default: `https://siftable.io`) |
| `--json` | — | Output raw JSON instead of tables |
| `--no-input` | — | Disable interactive prompts |

## Agent / Script Usage

All commands support `--json` for structured output, making the CLI composable with other tools:

```bash
# List tasks as JSON and filter with jq
sift tasks list --json | jq '.[] | select(.status == "in_progress")'

# Create a human planning task and capture the ID
TASK_ID=$(sift tasks create --title "Deploy v2" --json | jq -r '.task.id')

# Create executable agent work linked to the human task
sift work create --task "$TASK_ID" --agent codex --title "Implement Deploy v2" --verify "npm run build;npm test"

# Use in CI/CD scripts
export SIFT_TOKEN=sift_pat_...
sift tasks complete "$TASK_ID"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SIFT_TOKEN` | Personal access token for authentication |
| `SIFT_API_URL` | API base URL (default: `https://siftable.io`) |
| `SIFT_WORKSPACE_ID` | Workspace org ID to scope operations |

Legacy `EXF_TOKEN`, `EXF_API_URL`, `EXF_WORKSPACE_ID`, and `exf_pat_` tokens remain supported while older automation configs migrate.

## License

MIT
