# Siftable interactive copilot (`sift interactive`)

```bash
sift interactive
```

A terminal copilot that acts on your filesystem and the Siftable work graph — chat, run tools, edit code, spawn parallel agent branches, plan work, and render diagrams, all in the terminal.

This page documents the TUI exhaustively. For the non-interactive command surface, see [cli.md](./cli.md).

## Requirements & startup

- **[Bun](https://bun.sh) is required.** `sift interactive` re-execs Bun on the TUI entrypoint. If Bun isn't found it prints an install hint: `curl -fsSL https://bun.sh/install | bash`. Detection checks `which bun` then `~/.bun/bin/bun`.
- **Authentication is required.** It resolves a token from `--token` → `SIFT_TOKEN`/`EXF_TOKEN` → `sift auth login` credentials. Without one it tells you to log in.
- **Runs the brain in-process.** The copilot launches the bundled OpenFunction agent locally (`SIFT_LOCAL_BRAIN=1`) and talks to the Siftable API directly — there's no separate daemon to start.
- **Workspace root.** Writes are scoped to the nearest ancestor of your launch directory that contains `.git` (or the launch directory if none). This is the boundary `/status` reports and the native write path enforces. Your launch directory is preserved for tools that need it.

Flags accepted by the command: `--token`, `--api-url`, `--workspace` (the standard CLI base flags).

## The interface

The composer is a full readline-capable text area.

- **Enter** submits. **Shift+Enter**, **Ctrl+J**, or a literal line feed insert a newline.
- Submitting **while the agent is busy** queues your message; it's sent when the turn finishes.
- **`!command`** runs a shell command and drops its output into the transcript. A bare `!cd <path>` changes the session working directory; anything else runs via `bash -lc` (output clipped to ~4000 chars).
- **Paste handling** is automatic: large or structured pastes become a collapsed "chip" instead of flooding the composer; images (from the clipboard or a pasted file path) are validated and normalized, then attached as image chips.
- **`?`** on an empty composer shows the hotkeys.

## Slash commands

Type `/` to open the command menu (↑/↓ to choose, Enter/Tab to fill). Hidden commands are still typeable but don't appear in the menu or `/help`.

### Session

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/help` | | Grouped listing of available commands |
| `/hotkeys` | `keys` | Show the keyboard shortcuts |
| `/status` | | Model, working dir, workspace root, read/write scope, agents, queued work, brain URL |
| `/cwd [path]` | | Show or change the working directory (recomputes the workspace root) |
| `/copy [last\|all\|explorer]` | `transcript` | Copy the latest reply, the whole transcript, or the latest explorer report to the clipboard |
| `/clear` | | Reset the transcript |
| `/threads [clear]` | | Show or clear the persisted thread for this workspace (requires context compaction enabled) |
| `/compact` | `compress` | Force a context compaction now |
| `/quit` | `exit`, `q` | Exit |

### Models & engine

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/model [id] [effort]` | `models` | Open the model picker, or select a model (and optional reasoning effort) directly |
| `/codex [login\|on\|use\|off\|logout\|status]` | | Control the Codex (ChatGPT) engine; default subcommand is `status` |
| `/key <provider> <key>` · `/key vault <provider>` | | Store a provider API key for the brain, or hydrate it from Siftable Vault |
| `/login` | | Siftable device-code login from inside the TUI |
| `/explorer` | `explore` | Open the repo Explorer picker (context-gathering backend) |

### Branches & parallel agents

Git-native parent/child sessions, each in its own worktree.

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/branches` | `b` | Open the branches hub (or print the merge dashboard inline) |
| `/spawn <title> [--rw <globs>\|--rw-any\|--ro]` | | Start a child branch in a new worktree. Default writers are serialized on their `--rw` globs; `--rw-any` is an unserialized writer; `--ro` is read-only |
| `/merge [<id>] [--keep] [-m "msg"]` | | Squash-merge a ready child, or show the dashboard |
| `/rebase [<id>]` | | Replay a blocked child onto the moved base (auto-aborts on conflict) |
| `/sendback [<id>] <instructions>` | | Resume a reviewed child with new instructions |
| `/reject [<id>] [reason]` | | Terminally reject a child (keeps its worktree) |
| `/children` · `/enter <id>` · `/leave` · `/ready [--commit]` · `/queue` | `kids` | Hidden — folded into the `/branches` and `/work` overlays |

### Planning & work

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/work` | `w` | Open the work-queue hub (board of agents and items by status) |
| `/plan [objective \| work [--apply] [--after SRC:DST] [--limit N] \| view]` | | Free-text objective → a plan; `work` → a precedence DAG over the agent work queue rendered as a Mermaid graph (`--apply` persists derived edges, `--after` teaches an edge, `--limit` caps); `view` reopens the last plan diagram |
| `/handoff <title> [--agent codex] [--files a,b] [--acceptance a;b] [--verify a,b]` | | Create a Siftable work item from the current context |
| `/proof <claim>` | | Gather code/test evidence for a claim |
| `/remember <fact> --category <…>` | | Store durable code memory |
| `/focus` · `/ship` · `/recap [90d]` | | Hidden — priority actions, diff+test summary, recent-work clustering |

### Crews & collaboration

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/crew [list\|show\|new\|run]` | `crews` | Manage and run Siftable crews (multi-agent task graphs); bare opens the crew picker |
| `/collab [limit]` | `sessions` | Show in-process collaboration branch sessions |

### Diagrams & appearance

| Command | Aliases | What it does |
|---------|---------|--------------|
| `/mermaid [request\|file.mmd\|source]` | `diagram` | Render the last reply's ```mermaid blocks, a `.mmd` file, literal Mermaid source, or a natural-language diagram request. Flags `--ascii`, `--truecolor` |
| `/view` | | Open the last diagram in a pannable full-screen viewer |
| `/theme` | `appearance`, `themes` | Open the appearance picker |
| `/sounds [on\|off]` | `sound` | Toggle UI sounds |

## Models & engines

The model picker (`/model`) is a two-stage overlay: choose a **model** (↑/↓), then a **reasoning effort** (←/→). Your choice persists to `~/.siftable/prefs.json` and is restored on the next launch.

The catalog includes:

- **GPT-5.5 Codex** (`codex/gpt-5.5`) — runs through your ChatGPT plan via the Codex engine (see below). Efforts: low/medium/high/xhigh.
- **Claude Opus 4.8** — two routes: **Door A** via OpenRouter (`openrouter/anthropic/claude-opus-4.8`), and **Door B** direct to the Anthropic API (`anthropic/claude-opus-4-8`, needs `ANTHROPIC_API_KEY`; alias `claude-api`). Efforts: low/medium/high.
- **Claude Sonnet 4.6**, **Claude Haiku 4.5**, **Gemini 3.x Flash / Flash-Lite**, **GPT-5.4 mini / nano** — available via OpenRouter or first-party keys; the Flash/Haiku/mini/nano models are used as Explorer scouts.
- **Morph v3 Large** — apply-only (fast edit application); not a conversational brain.

**Engine routing:**

- **Codex** (`provider = codex`) drives the OpenAI `codex app-server` sidecar over JSON-RPC on stdio. Siftable does **not** own the OAuth — Codex manages ChatGPT sign-in; `/codex login` runs a device-code flow. Turns run in a `workspace-write` sandbox confined to the repo root with on-request approvals routed through the confirmation gate. Override the binary with `CODEX_BIN`.
- **All other providers** (OpenRouter, Anthropic, Gemini, OpenAI) route through the bundled OpenFunction agent, which reads `<PROVIDER>_API_KEY` from the environment. `/key <provider> <key>` sets it for the session; `/key vault <provider>` hydrates it from Siftable Vault behind an approval prompt (the secret is never printed or written to disk).

First-party provider keys: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `<PROVIDER>_API_KEY` generically.

## Repo Explorer

`/explorer` configures how the copilot gathers repository context before a turn. Modes: `auto`, `off`, `deterministic`, `scout`, `fanout`, `warpgrep`. You can pick a scout model and a budget (`cheap`/`normal`/`deep`). `warpgrep` uses Morph and needs `MORPH_API_KEY` (auto-hydrated from Vault when available). Settings persist to `prefs.json` and are exported to the brain as `SIFT_EXPLORER_*` environment variables.

## Skills

`/skills` lists the skills discovered for the current repo; `/skills <name>` prints one skill's body and bundled files. The agent can also invoke a skill via a `skill` tool, and up to ~50 discovered skills are advertised in its system prompt.

Skills are `SKILL.md` files discovered (project > user > builtin precedence) from:

- **Project:** `<root>/{.sift,.claude,.codex,.agents}/skills` (root = workspace root and cwd)
- **User:** `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.config/sift/skills`
- **Builtin:** shipped with the package

Scanning is depth-limited, ignores `node_modules`/`.git`/`dist`/`zig-out`/`.zig-cache`, and is symlink- and cycle-safe.

## Diagrams

Mermaid diagrams render directly in the terminal via a bundled `cell-render` engine. After a turn, ```mermaid blocks in the reply auto-render unless `SIFT_MERMAID_AUTORENDER=0` (or no renderer is available). Wide diagrams show a clipped inline preview plus the pannable `/view` viewer. Override the renderer binary with `SIFT_CELL_RENDER_BIN`.

## Keyboard shortcuts

Overlays capture the keyboard first, so bindings are mode-specific.

**Composer / global**

| Key | Action |
|-----|--------|
| `Enter` | Submit (queues if the agent is busy) |
| `Shift+Enter` / `Ctrl+J` | Newline |
| `↑` / `↓` (single-line draft) | Prompt history |
| `Tab` | Complete a lone `/foo` command |
| `Esc` | Abort the running turn → else clear the draft → else deselect transcript |
| `Ctrl+C` | Abort if busy → else clear draft → else deselect → else quit (never copies) |
| `Ctrl+D` (empty draft) | Quit |
| `Cmd/Super+A` | Select all (composer if it has text, else the transcript) |
| `Cmd+C` / `Ctrl+Shift+C` | Copy selection, else the latest reply |
| `Ctrl+O` | Toggle Explorer diagnostics |
| `?` (empty draft) | Show hotkeys |

Standard readline editing (`←/→`, `Ctrl+A/E`, `Home/End`, `Ctrl+U/K/W`, word motions) works in the composer.

**Slash menu:** `↑/↓` choose · `Enter`/`Tab` fill.
**Model picker:** model stage `↑/↓` + `Enter`; effort stage `←/→` + `Enter`; `Esc` back.
**Theme picker:** `↑/←` `↓/→` preview · `Enter` save · `Esc` revert.
**Diagram viewer:** arrows or `h/j/k/l` pan · `PgUp/PgDn` page · `Home/0` `End/$` jump · `Esc`/`q` close.
**Approval gate:** `y`/`Enter` allow once · `a` always · `b` bypass-all · `n`/`Esc` deny.
**Branches overlay:** `↑/↓` rows · `Enter` enter · `r` ready · `m` merge · `u` rebase · `x` reject · `a` then `y` abandon · `s` spawn form · `Esc` close.
**Work hub:** `↑/↓` rows · `Enter` detail · `p` plan · `f` focus · `r` recap · `s` ship · `v` evidence · `h` handoff · `Esc` close.

## Appearance & sound

- **Themes** (`/theme`) — 10 schemes; the default is **"sieve"** (warm amber on charcoal). Saved to `~/.siftable/appearance.json` and applied before the first paint. Swaps repaint live.
- **Sounds** (`/sounds`) — UI sound effects, **off by default**. Saved to `~/.siftable/sounds.json`; override with `SIFT_SOUNDS=1|0`. Degrades silently with no audio device (e.g. over SSH).

## Native acceleration

Performance-critical paths run through native [Zig](https://ziglang.org) modules loaded via Bun FFI, each with a lockstep TypeScript fallback. The published package ships prebuilt libraries for **macOS (Apple Silicon)** and **Linux (x64)**; other platforms use the TS fallback. Set `SIFT_NO_NATIVE=1` to force the fallbacks everywhere.

| Module | Role |
|--------|------|
| `thread_engine` | Context-window kernel: token estimation, chunk/compaction planning, conversation rollout persistence |
| `fs_engine` | Byte-level filesystem path: read/write/edit, directory listing, repo scan |
| `merge_master` | In-process branch registry: child/parent session state and merge-view projection |
| `composer_policy` | Paste decision (inline vs. chip) |
| `image_engine` | Image probe/validate/normalize for pasted/attached images |
| `collab_engine` | In-process collaboration session registry |
| `skill_meta` | `SKILL.md` frontmatter parser |

**Context compaction.** Set `SIFT_CONTEXT_COMPACTION=1` (any value other than `0`) to enable the live context-token meter in the status bar, plus thread persistence and resume. `/compact` forces a compaction; `/threads` manages the persisted thread.

## Configuration files

All under `~/.siftable/` unless noted:

| Path | Contents |
|------|----------|
| `~/.siftable/prefs.json` | Saved model + reasoning effort, Explorer settings |
| `~/.siftable/appearance.json` | Selected theme scheme |
| `~/.siftable/sounds.json` | Sound on/off |
| `~/.siftable/threads/<hash>.jsonl` | Per-workspace conversation rollout (when compaction is on) |
| `<repo-root>/.siftable/plans/overlay.json` | Plan precedence edges from `/plan work --apply`/`--after` |

## Environment variables

| Variable | Effect |
|----------|--------|
| `SIFT_TOKEN` / `EXF_TOKEN` | API token |
| `SIFT_API_URL` / `EXF_API_URL` | API base URL (default `https://siftable.io`) |
| `SIFT_WORKSPACE_ID` / `EXF_WORKSPACE_ID` | Workspace scope |
| `SIFT_CONTEXT_COMPACTION` | `!=0` enables the context meter + thread persistence/resume |
| `SIFT_NO_NATIVE` | `=1` disables Zig FFI, forces TypeScript fallbacks |
| `SIFT_MERMAID_AUTORENDER` | `=0` disables auto-rendering of ```mermaid blocks |
| `SIFT_SOUNDS` | `1/on` or `0/off` overrides the sound preference |
| `SIFT_CELL_RENDER_BIN` | Path to the `cell-render` (Mermaid) binary |
| `SIFT_GIT_BIN` | Override the `git` binary used for worktrees |
| `CODEX_BIN` | Override the `codex` binary for the Codex engine |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `<PROVIDER>_API_KEY` | First-party provider keys |
| `MORPH_API_KEY` | Enables the `warpgrep` Explorer mode |
| `EXECUTERM_MODEL` / `EXECUTERM_MODEL_PROVIDER` / `EXECUTERM_MODEL_EFFORT` | Startup model/provider/effort override |
| `EXECUTERM_OPENFUNCTION_PATH` | Dev override for the OpenFunction framework entry (published installs use the vendored copy) |

## Security model

- The copilot is **read-only by default**; write/edit tools are scoped to the workspace root and gated by an approval prompt.
- The approval gate is a single four-way control: **allow once** / **always allow** / **bypass-all** / **deny**. With no UI listening, requests **deny**.
- `EXECUTERM_AUTO_APPROVE` is always scrubbed at launch — there is no way to pre-authorize everything via env.
- `/status` reports the real read/write boundary, never a fictional one.
- Vault key reads require explicit approval and never write the secret to disk.
