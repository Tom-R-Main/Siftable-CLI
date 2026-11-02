/**
 * The writer's entry point for the first-run recipe (U6 contract rev 2, R4),
 * mounted read-only at /sift/writer.js and started by the launcher after `go`.
 * Self-contained: Node built-ins only, run with the image's node.
 *
 * It starts Claude Code (protocol anthropic) or codex (protocol openai) with
 * the model the frozen plan names, never one from user text:
 * - a fresh HOME with no login, credentials or auth file;
 * - the CLI's own config pointing only at the attempt's relay sidecar
 *   (ANTHROPIC_BASE_URL / OPENAI_BASE_URL, set by the supervisor), with a
 *   placeholder key the relay ignores;
 * - non-interactive, with the container as the sandbox;
 * - the task prompt from /sift/input.json as exactly one argument, never
 *   through a shell.
 * The supervisor's attempt cap bounds the run.
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const WRITER_INPUT = '/sift/input.json';
/** The pinned skills, checked by the supervisor and mounted read-only (skill-pin-v1.md); attemptSkills.ts SKILLS_MOUNT. */
export const WRITER_SKILLS = '/sift/skills';
/** What the CLIs send as a key; the relay authenticates the attempt, not this. */
export const PLACEHOLDER_KEY = 'sift-relay-placeholder';
const MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;
const MAX_TURNS = '40';
/** Credentials a CLI would prefer over its config; none may reach the writer. */
const DROPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export interface WriterInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A relay base URL fit to write into a config file: http(s), no credentials, nothing a TOML string would need escaped. */
function relayBase(value: string | undefined): string | undefined {
  if (!value || /["\\\s]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the CLI invocation and writes its config into a fresh home under `tmpRoot`. Returns why not, as a string, when it cannot. */
export function writerInvocation(input: unknown, env: NodeJS.ProcessEnv, tmpRoot = '/tmp', skillsDir = WRITER_SKILLS): WriterInvocation | string {
  const record = input as {plan?: {writer?: {protocol?: unknown; model?: unknown}}; task?: {prompt?: unknown; title?: unknown}};
  const protocol = record?.plan?.writer?.protocol;
  const model = record?.plan?.writer?.model;
  if (protocol !== 'anthropic' && protocol !== 'openai') return 'the plan names no supported writer protocol';
  if (typeof model !== 'string' || !MODEL.test(model)) return 'the plan names no writer model';
  const prompt = typeof record.task?.prompt === 'string' && record.task.prompt.trim() ? record.task.prompt
    : typeof record.task?.title === 'string' ? record.task.title : '';
  if (!prompt.trim()) return 'the task has no prompt';
  const base = relayBase(protocol === 'anthropic' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL);
  if (!base) return 'the relay base URL is missing';

  const home = mkdtempSync(path.join(tmpRoot, 'sift-writer-home-'));
  // Each CLI reads skills from its own home; both see exactly the pinned set, read-only.
  const linkSkills = (dir: string) => {
    if (!existsSync(skillsDir)) return;
    mkdirSync(dir, {recursive: true, mode: 0o700});
    symlinkSync(skillsDir, path.join(dir, 'skills'));
  };
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !DROPPED_ENV.includes(key)));
  if (protocol === 'anthropic') {
    linkSkills(path.join(home, '.claude'));
    const settings = path.join(home, 'sift-settings.json');
    writeFileSync(settings, JSON.stringify({apiKeyHelper: `printf %s ${PLACEHOLDER_KEY}`}), {mode: 0o600});
    return {
      command: 'claude',
      args: ['-p', '--model', model, '--max-turns', MAX_TURNS, '--dangerously-skip-permissions', '--settings', settings, '--', prompt],
      env: {...clean, HOME: home, ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'},
    };
  }
  const codexHome = path.join(home, '.codex');
  mkdirSync(codexHome, {mode: 0o700});
  linkSkills(codexHome);
  writeFileSync(path.join(codexHome, 'config.toml'), [
    `model = "${model}"`, 'model_provider = "sift"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', '',
    '[model_providers.sift]', 'name = "sift"', `base_url = "${base}"`, 'wire_api = "responses"', 'env_key = "SIFT_RELAY_KEY"', '',
  ].join('\n'), {mode: 0o600});
  return {
    command: 'codex',
    args: ['exec', '-m', model, '--skip-git-repo-check', '--', prompt],
    env: {...clean, HOME: home, CODEX_HOME: codexHome, OPENAI_BASE_URL: base, SIFT_RELAY_KEY: PLACEHOLDER_KEY},
  };
}

/** Runs the writer and returns its exit code; 78 when the input cannot start one, 127 when the CLI is missing. */
export async function runWriter(env: NodeJS.ProcessEnv, inputFile = WRITER_INPUT, tmpRoot = '/tmp',
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(inputFile, 'utf8'));
  } catch {
    log('sift writer: the attempt input is unreadable');
    return 78;
  }
  const invocation = writerInvocation(input, env, tmpRoot);
  if (typeof invocation === 'string') {
    log(`sift writer: ${invocation}`);
    return 78;
  }
  const child = spawn(invocation.command, invocation.args, {stdio: ['ignore', 'inherit', 'inherit'], env: invocation.env, cwd: process.cwd()});
  return new Promise((resolve) => {
    child.once('error', () => { log(`sift writer: ${invocation.command} is not installed in the image`); resolve(127); });
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

if (require.main === module) {
  runWriter(process.env).then((code) => process.exit(code), () => process.exit(1));
}
