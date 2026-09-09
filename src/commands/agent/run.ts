import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {existsSync, realpathSync, statSync} from 'node:fs';
import {constants} from 'node:os';
import {join, resolve} from 'node:path';
import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {findBun, resolveTuiRuntime} from '../interactive.js';

export function validateAgentBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error('Provider base URL must be an HTTPS URL or a loopback HTTP URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL requires HTTPS (or loopback HTTP), with no credentials, query, or fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

export function agentChildEnv(input: {
  cwd: string;
  runtimeDir: string;
  model: string;
  provider: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = {...(input.baseEnv ?? process.env)};
  for (const key of ['SIFT_PAT', 'EXF_PAT', 'SIFT_TOKEN', 'EXF_TOKEN', 'SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID',
    'EXECUTERM_AUTO_APPROVE', 'EXECUTERM_OPENFUNCTION_PATH']) delete env[key];
  return {
    ...env,
    SIFT_LOCAL_ONLY: '1',
    SIFT_LOCAL_BRAIN: '1',
    SIFT_INTERACTIVE_TUI_DIR: input.runtimeDir,
    SIFT_WORKSPACE_ROOT: input.cwd,
    SIFT_USER_CWD: input.cwd,
    EXECUTERM_MODEL: input.model,
    EXECUTERM_MODEL_PROVIDER: input.provider,
  };
}

/** Wait for closed stdio, including after interruption; never turn a signal into success. */
export function runHeadlessChild(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signals?: Pick<EventEmitter, 'on' | 'removeListener'>;
  supervisorHandoff?: boolean;
}): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, env: input.env, stdio: [input.supervisorHandoff ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    });
    const signals = input.signals ?? process;
    let interrupted: NodeJS.Signals | undefined;
    let executionError = false;
    const forward = (signal: NodeJS.Signals) => {
      interrupted ??= signal;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    const cleanup = () => {
      signals.removeListener('SIGINT', onInterrupt);
      signals.removeListener('SIGTERM', onTerminate);
    };
    signals.on('SIGINT', onInterrupt);
    signals.on('SIGTERM', onTerminate);
    child.once('error', error => {
      if (child.pid === undefined) { cleanup(); reject(error); }
      else executionError = true;
    });
    child.once('close', (code, signal) => {
      cleanup();
      const terminalSignal = signal ?? interrupted;
      if (terminalSignal) {
        resolveExit(128 + (constants.signals[terminalSignal] ?? 1));
      } else {
        resolveExit(!executionError && typeof code === 'number' && code >= 0 && code <= 255 ? code : 1);
      }
    });
  });
}

export default class AgentRun extends BaseCommand {
  static description = 'Run Sift’s local agent harness headlessly with durable session events';
  static examples = ['<%= config.bin %> agent run --provider openrouter --model z-ai/glm-5.3-flash --prompt "Inspect this repository"'];
  static flags = {
    ...BaseCommand.baseFlags,
    prompt: Flags.string({description: 'Task for the local agent', required: true}),
    provider: Flags.string({description: 'Provider adapter; credentials are read from the environment', required: true}),
    model: Flags.string({description: 'Exact provider model ID', required: true}),
    effort: Flags.string({description: 'Provider reasoning effort', options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']}),
    'base-url': Flags.string({description: 'Compatible provider endpoint (HTTPS or loopback HTTP)'}),
    cwd: Flags.string({description: 'Local workspace directory and writable root (defaults to current directory)'}),
    session: Flags.string({description: 'Resume this session ID; defaults to a fresh session'}),
    approval: Flags.string({description: 'Tool approval policy; allow approves local tool requests. Shell commands run with host permissions', options: ['deny', 'allow'], default: 'deny'}),
    'deadline-ms': Flags.integer({description: 'Turn deadline in milliseconds', min: 1, max: 86_400_000, default: 600_000}),
    'max-rounds': Flags.integer({description: 'Maximum tool rounds', min: 1, max: 256, default: 24}),
    'supervisor-handoff': Flags.boolean({description: 'Keep session jobs owned during external grading; requires a supervisor stdin pipe and JSONL'}),
    'handoff-timeout-ms': Flags.integer({description: 'Maximum external grading handoff duration', min: 1, max: 1_800_000}),
    'max-output-tokens': Flags.integer({description: 'Maximum provider output tokens', min: 1, max: 131_072}),
    'verify-command': Flags.string({description: 'Explicit post-run check as a JSON argv array; requires --verify-file'}),
    'verify-file': Flags.string({description: 'Exact candidate file to bind to the check (repeat for each file)', multiple: true}),
    format: Flags.string({description: 'Output protocol (--json selects json)', options: ['jsonl', 'json', 'text'], default: 'jsonl'}),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(AgentRun);
    if (flags.session && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(flags.session)) {
      this.error('Session IDs must use 1-128 letters, digits, dots, underscores, or hyphens and start with a letter or digit.', {exit: 2});
    }
    let cwd: string;
    try {
      cwd = realpathSync(resolve(flags.cwd || process.cwd()));
      if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      this.error('The agent workspace must be an existing directory.', {exit: 2});
    }
    let baseUrl: string | undefined;
    if (flags['base-url']) {
      try { baseUrl = validateAgentBaseUrl(flags['base-url']); } catch (error) {
        this.error((error as Error).message, {exit: 2});
      }
    }
    if (flags['verify-command']) {
      try {
        const command: unknown = JSON.parse(flags['verify-command']);
        if (!Array.isArray(command) || !command.length || typeof command[0] !== 'string' || !command[0].trim() || command.some(part => typeof part !== 'string' || part.includes('\0')) || !flags['verify-file']?.length) throw new Error('invalid verification specification');
      } catch { this.error('Verification requires a nonempty JSON argv array and --verify-file.', {exit: 2}); }
    } else if (flags['verify-file']?.length) this.error('--verify-file requires --verify-command.', {exit: 2});
    if (flags['verify-file']?.some(file => !file.trim() || file.includes('\0'))) this.error('--verify-file must name a candidate file.', {exit: 2});
    if (flags['supervisor-handoff'] && (this.jsonEnabled() || flags.format !== 'jsonl')) this.error('--supervisor-handoff requires JSONL format.', {exit: 2});
    if (flags['handoff-timeout-ms'] && !flags['supervisor-handoff']) this.error('--handoff-timeout-ms requires --supervisor-handoff.', {exit: 2});
    const preference = process.env.SIFT_INTERACTIVE_RUNTIME === 'source' ? 'source' : 'packaged';
    const runtime = resolveTuiRuntime(__dirname, preference);
    const entry = runtime && join(runtime.cwd, preference === 'source' ? 'headless.ts' : 'headless.js');
    if (!runtime || !entry || !existsSync(entry)) {
      this.error(`Could not locate the ${preference} headless agent runtime.`, {exit: 1});
    }
    const bun = findBun();
    if (!bun) this.error('Bun is required to run the headless agent. Install Bun before running this command.');
    const args = [entry, '--prompt', flags.prompt, '--provider', flags.provider, '--model', flags.model,
      '--cwd', cwd, '--session', flags.session ?? randomUUID(), '--approval', flags.approval,
      '--deadline-ms', String(flags['deadline-ms']), '--max-rounds', String(flags['max-rounds']),
      '--format', this.jsonEnabled() ? 'json' : flags.format];
    if (flags['verify-command']) args.push('--verify-command', flags['verify-command']);
    for (const file of flags['verify-file'] || []) args.push('--verify-file', file);
    if (flags.effort) args.push('--effort', flags.effort);
    if (baseUrl) args.push('--base-url', baseUrl);
    if (flags['max-output-tokens']) args.push('--max-output-tokens', String(flags['max-output-tokens']));
    if (flags['supervisor-handoff']) args.push('--supervisor-handoff');
    if (flags['handoff-timeout-ms']) args.push('--handoff-timeout-ms', String(flags['handoff-timeout-ms']));
    try {
      process.exitCode = await runHeadlessChild({
        executable: bun, args, cwd: runtime.cwd,
        env: agentChildEnv({cwd, runtimeDir: runtime.cwd, model: flags.model, provider: flags.provider}),
        supervisorHandoff: flags['supervisor-handoff'],
      });
    } catch {
      this.error('Failed to launch the headless agent runtime.');
    }
  }
}
