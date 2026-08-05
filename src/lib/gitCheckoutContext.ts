import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'ls-files', 'check-ignore']);

export interface ReadOnlyGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runReadOnlyGit(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<ReadOnlyGitResult> {
  const subcommand = args[0];
  const allowed = subcommand !== undefined && (
    ALLOWED_SUBCOMMANDS.has(subcommand)
    || (subcommand === 'config' && args[1] === '--get' && args.length === 3)
  );
  if (!allowed) throw new Error(`Git command is outside the environment read-only allowlist: ${subcommand ?? '<empty>'}`);
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: {
        ...process.env,
        ...environment,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return {stdout: result.stdout, stderr: result.stderr, exitCode: 0};
  } catch (error) {
    const failure = error as Error & {stdout?: string; stderr?: string; code?: number};
    if (typeof failure.code !== 'number') throw error;
    return {stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code};
  }
}

export type GitCheckoutContext =
  | {kind: 'not_a_repository'}
  | {kind: 'bare'; gitDir: string}
  | {
      kind: 'main_worktree' | 'linked_worktree' | 'submodule';
      checkoutRoot: string;
      gitDir: string;
      commonGitDir: string;
      superprojectRoot: string | null;
    };

async function revParse(cwd: string, flag: string): Promise<string | null> {
  const result = await runReadOnlyGit(cwd, ['rev-parse', flag]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function absoluteFrom(cwd: string, value: string): string {
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

export async function resolveGitCheckout(cwd: string): Promise<GitCheckoutContext> {
  const bare = await revParse(cwd, '--is-bare-repository');
  if (bare === null) return {kind: 'not_a_repository'};
  const gitDirValue = await revParse(cwd, '--git-dir');
  if (!gitDirValue) return {kind: 'not_a_repository'};
  const gitDir = absoluteFrom(cwd, gitDirValue);
  if (bare === 'true') return {kind: 'bare', gitDir};

  const checkoutRootValue = await revParse(cwd, '--show-toplevel');
  const commonGitDirValue = await revParse(cwd, '--git-common-dir');
  if (!checkoutRootValue || !commonGitDirValue) return {kind: 'not_a_repository'};
  const checkoutRoot = absoluteFrom(cwd, checkoutRootValue);
  const commonGitDir = absoluteFrom(cwd, commonGitDirValue);
  const superprojectValue = await revParse(cwd, '--show-superproject-working-tree');
  const superprojectRoot = superprojectValue ? absoluteFrom(cwd, superprojectValue) : null;
  return {
    kind: superprojectRoot ? 'submodule' : (gitDir === commonGitDir ? 'main_worktree' : 'linked_worktree'),
    checkoutRoot,
    gitDir,
    commonGitDir,
    superprojectRoot,
  };
}
