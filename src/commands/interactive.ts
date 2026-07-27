import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {Flags} from '@oclif/core';
import {BaseCommand, DEFAULT_API_URL} from '../lib/base-command.js';
import type {
  AiGenerateResponse,
  AiModelSummary,
  AiStreamTransport,
  AiTransport,
} from '../lib/ai-transport.js';
import {resolveToken} from '../lib/auth.js';

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] || process.env[legacy];
}

type InteractiveAiClient = Pick<AiTransport, 'listAiModels' | 'generateAi'>
  & Partial<Pick<AiStreamTransport, 'generateAiStream'>>;

export async function runInteractiveAiRequest(
  client: InteractiveAiClient,
  input: {
    connectionId?: string;
    model: string;
    prompt?: string;
    maxOutputTokens?: number;
    stream?: boolean;
    onDelta?: (text: string) => void;
  },
): Promise<{selected: AiModelSummary; response?: AiGenerateResponse}> {
  const listed = await client.listAiModels();
  if (listed.error || !listed.data) {
    throw new Error(`Unable to list eligible connected models (${listed.statusCode || 'transport'}).`);
  }
  const selected = listed.data.models.find(model => (
    model.model === input.model
    && (!input.connectionId || model.connectionId === input.connectionId)
  ));
  if (!selected) {
    throw new Error('No eligible connected model matched the requested selection.');
  }
  const safeSelected: AiModelSummary = {
    connectionId: selected.connectionId,
    connectionName: selected.connectionName,
    provider: selected.provider,
    model: selected.model,
    status: 'available',
  };
  if (input.prompt === undefined) return {selected: safeSelected};
  if (input.stream) {
    if (!client.generateAiStream) {
      throw new Error('Connected model streaming is unavailable.');
    }
    let text = '';
    let finishReason = 'unknown';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for await (const event of client.generateAiStream({
      connectionId: safeSelected.connectionId,
      model: safeSelected.model,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens,
    })) {
      if (event.type === 'delta') {
        text += event.text;
        input.onDelta?.(event.text);
      }
      if (event.type === 'usage') {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
      if (event.type === 'completed') finishReason = event.finishReason;
      if (event.type === 'failed') {
        throw new Error(`Connected model stream failed (${event.code}).`);
      }
    }
    return {
      selected: safeSelected,
      response: {
        connectionId: safeSelected.connectionId,
        model: safeSelected.model,
        text,
        finishReason,
        usage: {inputTokens, outputTokens},
      },
    };
  }
  const generated = await client.generateAi({
    connectionId: safeSelected.connectionId,
    model: safeSelected.model,
    prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens,
  });
  if (generated.error || !generated.data?.response) {
    throw new Error(`Connected model invocation failed (${generated.statusCode || 'transport'}).`);
  }
  const response = generated.data.response;
  return {
    selected: safeSelected,
    response: {
      connectionId: response.connectionId,
      model: response.model,
      text: response.text,
      finishReason: response.finishReason,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    },
  };
}

/**
 * Build the env the spawned Bun TUI runs with.
 *
 * SECURITY INVARIANT (tested in interactive.env.test.ts): A0 exposes only
 * read_file/list_dir — there is no mutating tool, so nothing should ever
 * auto-approve. We scrub any inherited EXECUTERM_AUTO_APPROVE so a stray value
 * can't grant silent writes if write tools are reintroduced in A1.
 *
 * The brain's OpenFunction `execufunction` provider reads SIFT_PAT / SIFT_API_URL
 * / SIFT_WORKSPACE_ID; SIFT_LOCAL_BRAIN tells index.tsx to use the in-process
 * LocalControlClient. EXECUTERM_OPENFUNCTION_PATH is an optional dev override;
 * published installs use the vendored runtime in interactive-tui/openfunction.
 */
export function buildChildEnv(opts: {
  token: string;
  apiUrl: string;
  workspaceId?: string;
  openfunctionPath?: string;
  userCwd?: string;
  /** Writable root for A1 write/edit tools. Defaults to the repo root above userCwd. */
  workspaceRoot?: string;
  /** Absolute path to the bundled interactive-tui directory. */
  tuiDir?: string;
  model?: string;
  provider?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...(opts.baseEnv ?? process.env)};

  // Safety scrub — do this FIRST so nothing below can be undone.
  delete env.EXECUTERM_AUTO_APPROVE;

  env.SIFT_LOCAL_BRAIN = '1';
  env.SIFT_PAT = opts.token;
  env.SIFT_API_URL = opts.apiUrl;
  if (opts.tuiDir) env.SIFT_INTERACTIVE_TUI_DIR = opts.tuiDir;
  if (opts.workspaceId) env.SIFT_WORKSPACE_ID = opts.workspaceId;
  if (opts.userCwd) env.SIFT_USER_CWD = opts.userCwd;

  // The writable root for A1 write/edit. The copilot is launched from a subdir
  // but should orient at the repo root, not believe it is jailed to the launch
  // directory — so default to the nearest ancestor containing `.git`. This is
  // the boundary /status reports and the Zig write path enforces.
  const workspaceRoot = opts.workspaceRoot ?? (opts.userCwd ? resolveWorkspaceRoot(opts.userCwd) : undefined);
  if (workspaceRoot) env.SIFT_WORKSPACE_ROOT = workspaceRoot;

  if (opts.openfunctionPath) {
    env.EXECUTERM_OPENFUNCTION_PATH = opts.openfunctionPath;
  } else {
    delete env.EXECUTERM_OPENFUNCTION_PATH;
  }

  if (opts.model) env.EXECUTERM_MODEL = opts.model;
  if (opts.provider) env.EXECUTERM_MODEL_PROVIDER = opts.provider;

  return env;
}

/**
 * The repo root for `startDir`: the nearest ancestor (inclusive) containing a
 * `.git` entry, or `startDir` itself if none is found. This becomes the
 * writable root so the copilot can act across the whole repo from any subdir,
 * rather than the misleading "jailed to the launch directory" behavior.
 */
export function resolveWorkspaceRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return resolve(startDir);
}

/** Locate the bun executable, or null if it isn't installed. */
export function findBun(): string | null {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], {
    encoding: 'utf8',
  });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split('\n').map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  }
  // Common default install location (bun installs to ~/.bun/bin by default).
  const fallback = join(process.env.HOME || '', '.bun', 'bin', 'bun');
  return existsSync(fallback) ? fallback : null;
}

/** Walk up from the compiled command to the package root, then to the TUI entry. */
export function resolveTuiDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'interactive-tui', 'index.tsx');
    if (existsSync(candidate)) return join(dir, 'interactive-tui');
    dir = join(dir, '..');
  }
  return null;
}

export default class Interactive extends BaseCommand {
  static description =
    'Launch the Siftable terminal copilot (sift interactive) — an in-process AI assistant over your tasks, work, calendar, projects, and people.';

  static examples = ['<%= config.bin %> interactive'];

  static flags = {
    ...BaseCommand.baseFlags,
    'connected-models': Flags.boolean({
      description: 'List eligible connected models and exit',
    }),
    connection: Flags.string({
      description: 'Select a Model Connection UUID for a gateway invocation',
      dependsOn: ['model'],
    }),
    model: Flags.string({
      description: 'Select an eligible connected model for a gateway invocation',
    }),
    prompt: Flags.string({
      description: 'Invoke the selected connected model once and exit',
      dependsOn: ['model'],
    }),
    'max-output-tokens': Flags.integer({
      description: 'Maximum connected-model output tokens (1-32768)',
      min: 1,
      max: 32_768,
      dependsOn: ['prompt'],
    }),
    stream: Flags.boolean({
      description: 'Consume selected connected-model output incrementally',
      default: false,
      dependsOn: ['prompt'],
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(Interactive);

    if (flags['connected-models'] || flags.model) {
      const client: AiTransport = await this.client(flags);
      if (flags['connected-models'] && !flags.model) {
        const listed = await client.listAiModels();
        this.handleAiApiError(listed, 'ai:models:read');
        const models = (listed.data?.models ?? []).map(model => ({
          connectionId: model.connectionId,
          connectionName: model.connectionName,
          provider: model.provider,
          model: model.model,
          status: model.status,
        }));
        if (this.jsonEnabled()) {
          this.log(JSON.stringify(models));
        } else {
          for (const model of models) {
            this.log(`${model.connectionId}\t${model.provider}\t${model.model}\t${model.connectionName}`);
          }
        }
        return;
      }
      const result = await runInteractiveAiRequest(client, {
        connectionId: flags.connection,
        model: flags.model!,
        prompt: flags.prompt,
        maxOutputTokens: flags['max-output-tokens'],
        stream: flags.stream,
        onDelta: flags.stream && !this.jsonEnabled()
          ? (delta: string) => this.log(delta)
          : undefined,
      });
      if (result.response) {
        if (this.jsonEnabled()) this.log(JSON.stringify(result));
        else if (!flags.stream) this.log(result.response.text);
      } else {
        this.log(`selected ${result.selected.connectionId} ${result.selected.model}`);
      }
      return;
    }

    const token = flags.token || envValue('SIFT_TOKEN', 'EXF_TOKEN') || resolveToken();
    if (!token) {
      this.error('No authentication token found. Run `sift auth login` or set SIFT_TOKEN.');
    }

    const bun = findBun();
    if (!bun) {
      this.error(
        'Bun is required to run `sift interactive`.\n' +
          'Install it: curl -fsSL https://bun.sh/install | bash   (see https://bun.sh)',
      );
    }

    const tuiDir = resolveTuiDir(__dirname);
    if (!tuiDir) {
      this.error('Could not locate the interactive TUI (interactive-tui/index.tsx).');
    }

    const env = buildChildEnv({
      token,
      apiUrl: flags['api-url'] || envValue('SIFT_API_URL', 'EXF_API_URL') || DEFAULT_API_URL,
      workspaceId: flags.workspace || envValue('SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID'),
      userCwd: process.cwd(),
      tuiDir,
      baseEnv: process.env,
    });

    // Run bun FROM the TUI dir so it finds bunfig.toml (the @opentui/solid
    // preload) and node_modules. The user's working directory is preserved in
    // SIFT_USER_CWD for tools/shell that should act where the user invoked us.
    const result = spawnSync(bun, ['index.tsx'], {
      cwd: tuiDir,
      env,
      stdio: 'inherit',
    });

    if (result.error) {
      this.error(`Failed to launch the copilot: ${result.error.message}`);
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      this.exit(result.status);
    }
  }
}
