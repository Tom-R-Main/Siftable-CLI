/**
 * In-process OpenFunction brain for `sift interactive` (A0 shape proof).
 *
 * Forked from execuTerm-refork daemon/src/services/openfunctionBrain.ts, trimmed
 * for the standalone copilot:
 *   - no daemon coupling (own BrainEvent type, no ../exfClient import)
 *   - READ-ONLY tools for A0. Write/edit/run land in A1 (behind a real TUI
 *     confirm); dispatch in A2.
 *   - no auth.json fallback: the oclif launcher resolves the token and passes it
 *     in as SIFT_PAT, so the provider always has a token in-env.
 *
 * Runs INSIDE the spawned Bun TUI process (not the Node oclif command). The
 * launcher (src/commands/interactive.ts) sets the env contract:
 *   SIFT_PAT / SIFT_API_URL / SIFT_WORKSPACE_ID  Siftable context provider creds
 *   EXECUTERM_OPENFUNCTION_PATH                   path to OpenFunction framework index
 *   SIFT_LOCAL_BRAIN=1                            tells index.tsx to use LocalControlClient
 * The launcher DELETES EXECUTERM_AUTO_APPROVE — A0 has no write tools, so there
 * is nothing to auto-approve; the scrub keeps the invariant honest if a stray
 * value is inherited.
 */
import {
  batchReadFiles,
  codeSearch,
  editText,
  findLocalFiles,
  inspectLocalWorkspace,
  readText,
  searchLiteral,
  writeText,
} from './fsEngine';
import { requestConfirm } from './confirmGate';
import { chatInputText, classifyExplorerPrompt, prepareExplorerInput, clearRepoExplorerCache } from './explorer';
import { isAbsolute, resolve as resolvePath } from 'node:path';

/** Relay-compatible event shape the TUI already understands (token, tool_call, tool_result, done, error). */
export interface BrainEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'done' | 'error';
  content?: string;
  error?: string;
  toolCall?: { name: string; args?: Record<string, unknown>; detail?: string };
  toolResult?: { name: string; success?: boolean; output?: string };
  message?: { content?: string };
  [key: string]: unknown;
}

export interface BrainAskResult {
  text: string;
  error?: string;
}

export type ChatInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataUrl: string; detail?: 'auto' | 'low' | 'high' };
export type ChatInput = string | ChatInputPart[];

const LEAN_PROMPT =
  'You are the Siftable terminal copilot — an executive-function assistant in the user\'s terminal. ' +
  'Be terse and concrete; prefer a direct answer over a preamble. ' +
  'Use your tools to answer about the user\'s tasks, work items, calendar, projects, people, and local code. ' +
  'For the local codebase, reach for the search tools (inspect_local_workspace, find_local_files, ' +
  'search_local_files, code_search, batch_read_files) before crawling file-by-file. ' +
  'For broad content searches, start with file/path discovery or low-detail locations and a modest maxFiles cap; escalate scope and snippets/full only after narrowing candidates. ' +
  'Use code_search forceRefresh after external commands likely changed the workspace. ' +
  'If a search result is truncated/capped, describe it as partial and narrow or explicitly broaden before treating absence as definitive.';

function entryPath(): string {
  // The launcher (interactive.ts) normally sets EXECUTERM_OPENFUNCTION_PATH to a
  // resolved entry. This bare fallback only fires if the brain is run without
  // it; the repo ships `.ts` (no build), and Bun won't resolve `.js`→`.ts`, so
  // default to the source file that actually exists.
  return (
    process.env.EXECUTERM_OPENFUNCTION_PATH ||
    `${process.env.HOME}/projects/OpenFunction/src/framework/index.ts`
  );
}

interface OfChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'done';
  text?: string;
  toolCall?: { name: string; args?: Record<string, unknown> };
  toolResult?: { name: string; success?: boolean };
  result?: { content?: string };
}

interface OfModule {
  createChatAgent: (config: Record<string, unknown>) => Promise<{
    chat: (msg: ChatInput, o: { stream: true }) => AsyncIterable<OfChunk>;
  }>;
  defineTool: (def: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
  }) => unknown;
  ok: (data: unknown, message?: string) => unknown;
  err: (error: string) => unknown;
}

let agentPromise: Promise<{ chat: (msg: ChatInput, o: { stream: true }) => AsyncIterable<OfChunk> }> | null =
  null;

/** Provider id that routes the brain to the Codex app-server engine. */
const CODEX_PROVIDER = 'codex';
/** OpenFunction's default model — used to decide when to pass a model override to Codex. */
const DEFAULT_OPENFUNCTION_MODEL = 'google/gemini-3.5-flash';

let currentProvider = process.env.EXECUTERM_MODEL_PROVIDER || 'openrouter';
let currentModel = process.env.EXECUTERM_MODEL || DEFAULT_OPENFUNCTION_MODEL;
let currentEffort: string | undefined = process.env.EXECUTERM_MODEL_EFFORT || undefined;

/** Current provider/model/effort — surfaced in /control/state and the status bar. */
export function getBrainModel(): { provider: string; model: string; effort?: string } {
  return { provider: currentProvider, model: currentModel, effort: currentEffort };
}

/**
 * Switch the model/provider/reasoning-effort and/or store a provider API key
 * (the /model and /key commands). Rebuilds the agent lazily.
 */
export function setBrainModel(input: {
  provider?: string;
  model?: string;
  apiKey?: string;
  effort?: string;
}): { provider: string; model: string; effort?: string } {
  if (input.provider) currentProvider = input.provider;
  if (input.model) currentModel = input.model;
  // effort is explicitly settable to "" to clear it back to provider default.
  if (input.effort !== undefined) currentEffort = input.effort || undefined;
  if (input.apiKey && input.provider) {
    // OpenFunction adapters read provider keys from env (e.g. OPENROUTER_API_KEY).
    process.env[`${input.provider.toUpperCase()}_API_KEY`] = input.apiKey;
  }
  agentPromise = null; // force rebuild with the new model/key/effort on next ask
  return getBrainModel();
}

const MAX_READ_BYTES = 64 * 1024;

/**
 * Local-filesystem tools.
 *
 * Reads (A0) are always available. Writes (A1) — write_file / edit_file — are
 * registered only when SIFT_WORKSPACE_ROOT is set, and every mutation goes
 * through `requestConfirm` (a real TUI Y/N round-trip) before touching disk.
 * There is no auto-approve path: the confirm gate denies if no UI is listening,
 * and the Zig layer independently jails writes to the workspace root.
 */
function buildLocalTools(of: OfModule): unknown[] {
  const home = process.env.HOME || '';
  const userCwd = process.env.SIFT_USER_CWD || process.cwd();
  // Writable root for A1. Empty → write/edit tools are not registered at all.
  const workspaceRoot = process.env.SIFT_WORKSPACE_ROOT || '';
  const resolveLocalPath = (p: string) => {
    const input = p || '.';
    if (input.startsWith('~')) return input.replace(/^~/, home);
    if (isAbsolute(input)) return input;
    return resolvePath(userCwd, input);
  };

  const readFile = of.defineTool({
    name: 'read_file',
    description:
      "Read a UTF-8 text file from the user's local machine. Returns up to 64KB of content. Skips binary files.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute, ~-relative, or current-workspace-relative file path' } },
      required: ['path'],
    },
    handler: async (params) => {
      try {
        const path = resolveLocalPath(String(params.path));
        const result = await readText(path, MAX_READ_BYTES);
        return of.ok(result);
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const listDir = of.defineTool({
    name: 'list_dir',
    description: "List entries in a directory on the user's local machine.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute, ~-relative, or current-workspace-relative directory path' } },
      required: ['path'],
    },
    handler: async (params) => {
      try {
        const fs = await import('node:fs/promises');
        const path = resolveLocalPath(String(params.path || '.'));
        const entries = await fs.readdir(path, { withFileTypes: true });
        return of.ok({
          path,
          entries: entries.slice(0, 500).map((e) => ({ name: e.name, dir: e.isDirectory() })),
        });
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const searchLocalFiles = of.defineTool({
    name: 'search_local_files',
    description:
      "Search local workspace file CONTENTS for a literal string. This is grep-like content search, not file-name search. Bounded, read-only, skips hidden/noisy dirs and binary/large files by default.",
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Directory to search. Defaults to the directory where `sift interactive` was launched.',
        },
        query: { type: 'string', description: 'Literal text to search for (not regex)' },
        maxFiles: { type: 'integer', description: 'Max files to scan. Use a lower cap for broad discovery; raise only when explicitly broadening scope.' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 100)' },
        includeHidden: { type: 'boolean', description: 'Include hidden files/directories (default false)' },
        includeVendor: { type: 'boolean', description: 'Include dependency/vendor directories such as node_modules and vendor (default false)' },
        includeBuildOutputs: { type: 'boolean', description: 'Include build/generated-output directories such as dist, target, .turbo, and zig-cache (default false)' },
        detail: { type: 'string', enum: ['paths', 'locations', 'snippets', 'full'], description: 'Result detail level. Use paths for broad discovery, locations for line/column only, and snippets/full only after narrowing candidate files. If capped/truncated is true, the result is partial.' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      try {
        const root = resolveLocalPath(String(params.root || process.env.SIFT_USER_CWD || '.'));
        const query = String(params.query || '');
        if (!query) return of.err('query is required');
        const result = await searchLiteral(root, query, {
          maxFiles: typeof params.maxFiles === 'number' ? params.maxFiles : undefined,
          maxMatches: typeof params.maxMatches === 'number' ? params.maxMatches : 100,
          includeHidden: params.includeHidden === true,
          includeVendor: params.includeVendor === true,
          includeBuildOutputs: params.includeBuildOutputs === true,
          detail: ['paths', 'locations', 'snippets', 'full'].includes(String(params.detail)) ? String(params.detail) as 'paths' | 'locations' | 'snippets' | 'full' : undefined,
        });
        return of.ok(result, `Found ${result.matches.length} match(es)`);
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const inspectWorkspace = of.defineTool({
    name: 'inspect_local_workspace',
    description:
      'Summarize the local workspace: detected languages, key files, compact top-level tree, and likely symbols. Use this first for broad codebase orientation.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Directory to inspect. Defaults to the directory where `sift interactive` was launched.',
        },
      },
    },
    handler: async (params) => {
      try {
        const root = resolveLocalPath(String(params.root || process.env.SIFT_USER_CWD || '.'));
        return of.ok(await inspectLocalWorkspace(root));
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const findLocalFilesTool = of.defineTool({
    name: 'find_local_files',
    description:
      'Fuzzy path/name search for local files, similar to Codex @-mention file search. This matches file paths, not file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Directory to search. Defaults to the directory where `sift interactive` was launched.',
        },
        query: { type: 'string', description: 'File/path/name query, e.g. "brain", "fs engine", "package json"' },
        limit: { type: 'integer', description: 'Max path matches to return (default 64)' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      try {
        const root = resolveLocalPath(String(params.root || process.env.SIFT_USER_CWD || '.'));
        const query = String(params.query || '');
        if (!query) return of.err('query is required');
        const result = await findLocalFiles({
          root,
          query,
          limit: typeof params.limit === 'number' ? params.limit : 64,
        });
        return of.ok(result, `Found ${result.matches.length} path match(es)`);
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const codeSearchTool = of.defineTool({
    name: 'code_search',
    description:
      'Broad read-only code search for codebase questions. Compiles likely content queries, ranks files/spans, and suggests batch_read_files follow-ups. Use for "where is X handled" or "scour this codebase" style questions.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Directory to search. Defaults to the directory where `sift interactive` was launched.',
        },
        intent: { type: 'string', description: 'The user question or investigation goal' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Optional exact literals to search for' },
        maxFiles: { type: 'integer', description: 'Max eligible files to search. Defaults to 500 for broad agent search; raise only when broadening a partial result.' },
        maxSpans: { type: 'integer', description: 'Max ranked spans to return (default 12)' },
        forceRefresh: { type: 'boolean', description: 'Bypass the session file-set cache when the workspace may have changed outside the fs tools.' },
        maxCacheAgeMs: { type: 'integer', description: 'Override the session file-set cache max age in milliseconds.' },
        useContentCache: { type: 'boolean', description: 'Experimental: reuse recently read file contents for repeated broad searches. Disabled by default.' },
      },
      required: ['intent'],
    },
    handler: async (params) => {
      try {
        const root = resolveLocalPath(String(params.root || process.env.SIFT_USER_CWD || '.'));
        const intent = String(params.intent || '');
        if (!intent) return of.err('intent is required');
        const queries = Array.isArray(params.queries) ? params.queries.map(String) : undefined;
        return of.ok(await codeSearch({
          root,
          intent,
          queries,
          maxFiles: typeof params.maxFiles === 'number' ? params.maxFiles : 500,
          maxSpans: typeof params.maxSpans === 'number' ? params.maxSpans : 12,
          forceRefresh: params.forceRefresh === true,
          maxCacheAgeMs: typeof params.maxCacheAgeMs === 'number' ? params.maxCacheAgeMs : undefined,
          useContentCache: params.useContentCache === true,
        }));
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const batchReadFilesTool = of.defineTool({
    name: 'batch_read_files',
    description:
      'Read several local files or line ranges in one read-only call. Use after inspect_local_workspace, find_local_files, or code_search has ranked paths.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Workspace root. Defaults to the directory where `sift interactive` was launched.',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              startLine: { type: 'integer' },
              endLine: { type: 'integer' },
              maxBytes: { type: 'integer' },
            },
            required: ['path'],
          },
          description: 'Files or file ranges to read, max 12.',
        },
      },
      required: ['files'],
    },
    handler: async (params) => {
      try {
        const root = resolveLocalPath(String(params.root || process.env.SIFT_USER_CWD || '.'));
        if (!Array.isArray(params.files)) return of.err('files array is required');
        const files = params.files
          .map((item) => {
            const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
            return {
              path: String(record.path || ''),
              startLine: typeof record.startLine === 'number' ? record.startLine : undefined,
              endLine: typeof record.endLine === 'number' ? record.endLine : undefined,
              maxBytes: typeof record.maxBytes === 'number' ? record.maxBytes : undefined,
            };
          })
          .filter((item) => item.path);
        return of.ok(await batchReadFiles(files, root));
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const writeFile = of.defineTool({
    name: 'write_file',
    description:
      "Create or overwrite a UTF-8 text file on the user's machine. Requires interactive user approval and is restricted to the current workspace. Writes are atomic (temp file + rename).",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute, ~-relative, or workspace-relative file path' },
        content: { type: 'string', description: 'Full file contents to write' },
        createOnly: { type: 'boolean', description: 'Fail if the file already exists instead of overwriting (default false)' },
      },
      required: ['path', 'content'],
    },
    handler: async (params) => {
      try {
        const path = resolveLocalPath(String(params.path));
        const content = String(params.content ?? '');
        const approved = await requestConfirm({ kind: 'write', path, detail: `${content.length} bytes` });
        if (!approved) return of.err('write declined by user');
        const result = await writeText(path, content, {
          root: workspaceRoot,
          makePath: true,
          createOnly: params.createOnly === true,
        });
        clearRepoExplorerCache(workspaceRoot);
        return of.ok(result, `Wrote ${result.bytesWritten} bytes${result.created ? ' (created)' : ''}`);
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const editFile = of.defineTool({
    name: 'edit_file',
    description:
      "Replace an exact, unique string in a file in place. Requires interactive user approval and is restricted to the current workspace. The `old` text must appear exactly once; reads the file first and refuses ambiguous matches.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute, ~-relative, or workspace-relative file path' },
        old: { type: 'string', description: 'Exact text to replace — must match exactly once in the file' },
        new: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old', 'new'],
    },
    handler: async (params) => {
      try {
        const path = resolveLocalPath(String(params.path));
        const oldStr = String(params.old ?? '');
        const newStr = String(params.new ?? '');
        if (!oldStr) return of.err("edit_file: 'old' must not be empty");
        const approved = await requestConfirm({ kind: 'edit', path, detail: `replace ${oldStr.length}→${newStr.length} chars` });
        if (!approved) return of.err('edit declined by user');
        const result = await editText(path, oldStr, newStr, { root: workspaceRoot });
        clearRepoExplorerCache(workspaceRoot);
        return of.ok(result, `Edited (${result.replacements} replacement${result.replacements === 1 ? '' : 's'})`);
      } catch (e) {
        return of.err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const tools: unknown[] = [
    inspectWorkspace,
    findLocalFilesTool,
    searchLocalFiles,
    codeSearchTool,
    batchReadFilesTool,
    readFile,
    listDir,
  ];
  // A1 write surface: only when a workspace root is set. Each call is still
  // confirm-gated and Zig-jailed; registration just exposes the tools.
  if (workspaceRoot) tools.push(writeFile, editFile);
  return tools;
}

/**
 * Load OpenFunction's .env (model provider keys) into process.env so the brain
 * has OPENROUTER_API_KEY etc. even when launched from a clean env. Never
 * overrides an already-set var. Runs once. The Siftable token (SIFT_PAT) is
 * supplied by the launcher, so there is no auth.json fallback here.
 */
let envLoaded = false;
async function loadOpenFunctionEnv(): Promise<void> {
  if (envLoaded) return;
  envLoaded = true;
  try {
    const fs = await import('node:fs/promises');
    const envPath = entryPath().replace(/\/src\/framework\/index\.(ts|js)$/, '/.env');
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (key && val && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env — rely on inherited env */
  }
}

async function getAgent() {
  if (!agentPromise) {
    agentPromise = (async () => {
      await loadOpenFunctionEnv();
      // A bun-compiled binary injects OpenFunction statically (dynamic import of
      // its TS can't be bundled); dev resolves it lazily from EXECUTERM_OPENFUNCTION_PATH.
      const injected = (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ as
        | OfModule
        | undefined;
      const of = injected ?? ((await import(entryPath())) as unknown as OfModule);
      return of.createChatAgent({
        name: 'siftable-control',
        provider: currentProvider,
        model: currentModel,
        ...(currentEffort ? { reasoningEffort: currentEffort } : {}),
        providers: ['execufunction'],
        tools: buildLocalTools(of),
        memory: false,
        prompt: LEAN_PROMPT,
      });
    })();
  }
  return agentPromise;
}

/**
 * Ask the OpenFunction brain. Emits relay-compatible events to onEvent and
 * resolves with the assembled reply text. Returns {error} (never throws) so the
 * caller can render a degraded state instead of crashing the TUI.
 */
export async function openfunctionAsk(
  input: ChatInput,
  onEvent: (event: BrainEvent) => void,
  signal?: AbortSignal,
): Promise<BrainAskResult> {
  let preparedInput = input;
  if (!signal?.aborted && classifyExplorerPrompt(chatInputText(input)) !== 'skipped') {
    onEvent({ type: 'tool_call', toolCall: { name: 'repo_explorer', detail: 'read-only preflight' } });
    try {
      const prepared = await prepareExplorerInput(input, { root: process.env.SIFT_USER_CWD || process.cwd() });
      preparedInput = prepared.input as ChatInput;
      if (prepared.injected && process.env.SIFT_EXPLORER_DEBUG === '1' && prepared.reportText) {
        console.error(prepared.reportText);
      }
      onEvent({
        type: 'tool_result',
        toolResult: {
          name: 'repo_explorer',
          success: true,
          output: prepared.injected
            ? `${prepared.report.mode}; ${prepared.report.metrics.queriesRun} querie(s); ${prepared.report.likelyFiles.length} likely file(s); ${prepared.report.metrics.filesSearched} file(s) searched; ${prepared.report.metrics.reportChars} char report; ${prepared.report.metrics.elapsedMs}ms`
            : 'skipped',
        },
      });
    } catch (err) {
      onEvent({
        type: 'tool_result',
        toolResult: {
          name: 'repo_explorer',
          success: false,
          output: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Codex engine: when the active provider is `codex`, drive the OpenAI
  // `codex app-server` sidecar (ChatGPT-subscription auth) instead of the
  // OpenFunction agent. Lazily imported to avoid a static import cycle
  // (codexEngine type-imports this module).
  if (currentProvider === CODEX_PROVIDER) {
    const { codexAsk } = await import('./codexEngine');
    // Pass the model only when it isn't the OpenFunction default, so a fresh
    // /codex switch lets app-server pick its own default model.
    const model = currentModel && currentModel !== DEFAULT_OPENFUNCTION_MODEL ? currentModel : undefined;
    return codexAsk(preparedInput, onEvent, { signal, model, effort: currentEffort });
  }

  let agent: Awaited<ReturnType<typeof getAgent>>;
  try {
    agent = await getAgent();
  } catch (err) {
    return {
      text: '',
      error: `OpenFunction brain unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let assembled = '';
  try {
    for await (const chunk of agent.chat(preparedInput, { stream: true })) {
      if (chunk.type === 'text' && typeof chunk.text === 'string') {
        assembled += chunk.text;
        onEvent({ type: 'token', content: chunk.text });
      } else if (chunk.type === 'tool_call') {
        // Surface the call and a salient arg (path/query/command) so the user
        // sees what each tool is doing — the TUI derives a one-line label.
        onEvent({
          type: 'tool_call',
          toolCall: { name: chunk.toolCall?.name ?? 'tool', args: chunk.toolCall?.args },
        });
      } else if (chunk.type === 'tool_result') {
        onEvent({
          type: 'tool_result',
          toolResult: { name: chunk.toolResult?.name ?? 'tool', success: chunk.toolResult?.success ?? true },
        });
      } else if (chunk.type === 'done') {
        onEvent({
          type: 'done',
          ...(chunk.result?.content ? { message: { content: chunk.result.content } } : {}),
        });
      }
    }
    return { text: assembled };
  } catch (err) {
    return { text: assembled, error: err instanceof Error ? err.message : String(err) };
  }
}
