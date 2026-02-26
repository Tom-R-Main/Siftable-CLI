# @execufunction/cli

Command-line interface for [ExecuFunction](https://execufunction.com) — AI executive function assistant for tasks, calendar, knowledge, code indexing, and CRM.

## Installation

```bash
# Run directly
npx @execufunction/cli <command>

# Or install globally
npm install -g @execufunction/cli
```

## Quick Start

### 1. Authenticate

```bash
exf auth login
```

Or set a Personal Access Token directly:

```bash
export EXF_TOKEN=exf_pat_your_token_here
```

### 2. Run your first command

```bash
exf tasks list
exf tasks create --title "Ship CLI v1"
exf notes search "deployment process"
```

## Command Reference

### Auth
| Command | Description |
|---------|-------------|
| `exf auth login` | Authenticate with ExecuFunction |
| `exf auth logout` | Clear stored credentials |
| `exf auth status` | Show current auth status |

### Tasks
| Command | Description |
|---------|-------------|
| `exf tasks list` | List tasks (filterable by status, project) |
| `exf tasks get <id>` | Get task details |
| `exf tasks create` | Create a task |
| `exf tasks update <id>` | Update a task |
| `exf tasks complete <id>` | Mark a task complete |
| `exf tasks delete <id>` | Delete a task |

### Projects
| Command | Description |
|---------|-------------|
| `exf projects list` | List projects |
| `exf projects create` | Create a project |
| `exf projects update <id>` | Update a project |
| `exf projects archive <id>` | Archive a project |
| `exf projects context <id>` | Get full project context |

### Notes
| Command | Description |
|---------|-------------|
| `exf notes list` | List notes |
| `exf notes get <id>` | Get note with full content |
| `exf notes create` | Create a note |
| `exf notes search <query>` | Search knowledge base |
| `exf notes update <id>` | Update a note |
| `exf notes delete <id>` | Delete a note |

### Calendar
| Command | Description |
|---------|-------------|
| `exf calendar list` | List events (filterable by date range) |
| `exf calendar create` | Create an event |
| `exf calendar update <id>` | Update an event |
| `exf calendar delete <id>` | Delete an event |

### People
| Command | Description |
|---------|-------------|
| `exf people list` | List contacts |
| `exf people search <query>` | Search contacts |

### Vault
| Command | Description |
|---------|-------------|
| `exf vault list` | List vault entries (metadata only) |
| `exf vault create` | Store an encrypted secret |
| `exf vault read <id>` | Decrypt and read a secret |
| `exf vault search <query>` | Search vault entries |
| `exf vault update <id>` | Update entry metadata |

### Codebase
| Command | Description |
|---------|-------------|
| `exf codebase list` | List indexed repositories |
| `exf codebase register` | Register a repo for indexing |
| `exf codebase status <id>` | Check indexing status |
| `exf codebase index <id>` | Trigger indexing |
| `exf codebase search <query>` | Semantic code search |
| `exf codebase snapshot <id>` | Get latest snapshot |
| `exf codebase delete <id>` | Delete a repository |

### Code Tools
| Command | Description |
|---------|-------------|
| `exf code history <repo>` | Get commit history |
| `exf code who-knows <repo> <area>` | Find experts for a code area |
| `exf code blame <file>` | Git blame for a file |
| `exf code link <task>` | Link a task to code |
| `exf code expertise <repo>` | Refresh expertise index |
| `exf code memory store` | Store a codebase fact |
| `exf code memory list` | List stored facts |
| `exf code memory search <query>` | Search stored facts |
| `exf code memory delete <id>` | Delete a stored fact |

### Documents
| Command | Description |
|---------|-------------|
| `exf documents upload <file>` | Upload a document (PDF, MD, TXT) as a note |

## Global Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `--token` | `EXF_TOKEN` | Personal access token |
| `--api-url` | `EXF_API_URL` | API base URL (default: `https://execufunction.com`) |
| `--json` | — | Output raw JSON instead of tables |
| `--no-input` | — | Disable interactive prompts |

## Agent / Script Usage

All commands support `--json` for structured output, making the CLI composable with other tools:

```bash
# List tasks as JSON and filter with jq
exf tasks list --json | jq '.[] | select(.status == "in_progress")'

# Create a task and capture the ID
TASK_ID=$(exf tasks create --title "Deploy v2" --json | jq -r '.task.id')

# Use in CI/CD scripts
export EXF_TOKEN=exf_pat_...
exf tasks complete "$TASK_ID"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `EXF_TOKEN` | Personal access token for authentication |
| `EXF_API_URL` | API base URL (default: `https://execufunction.com`) |

## License

MIT
