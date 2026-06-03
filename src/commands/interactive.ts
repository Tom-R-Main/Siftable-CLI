import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {BaseCommand, DEFAULT_API_URL} from '../lib/base-command.js';
import {resolveToken} from '../lib/auth.js';

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] || process.env[legacy];
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
 * LocalControlClient; EXECUTERM_OPENFUNCTION_PATH points at the framework entry.
 */
export function buildChildEnv(opts: {
  token: string;
  apiUrl: string;
  workspaceId?: string;
  openfunctionPath?: string;
  userCwd?: string;
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
  if (opts.workspaceId) env.SIFT_WORKSPACE_ID = opts.workspaceId;
  if (opts.userCwd) env.SIFT_USER_CWD = opts.userCwd;

  env.EXECUTERM_OPENFUNCTION_PATH =
    opts.openfunctionPath ||
    env.EXECUTERM_OPENFUNCTION_PATH ||
    `${env.HOME}/projects/OpenFunction/src/framework/index.js`;

  if (opts.model) env.EXECUTERM_MODEL = opts.model;
  if (opts.provider) env.EXECUTERM_MODEL_PROVIDER = opts.provider;

  return env;
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
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(Interactive);

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
