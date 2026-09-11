import { spawn } from 'node:child_process';
import type { ToolExecutionContext } from './agent-harness/framework/execution-context';
import type { ToolResult } from './agent-harness/framework/types';

/** Keep one output body in model context; the journal/UI retain the receipt. */
export function projectShellResult(result: ToolResult): ToolResult {
  const data = result.data as Partial<ShellExecutionResult> | undefined;
  // Directory changes and pre-dispatch errors have different result shapes.
  if (!data || typeof data.output !== 'string' || typeof data.stdout !== 'string'
    || typeof data.stderr !== 'string' || typeof data.command !== 'string') return result;
  const {command: _command, stdout: _stdout, stderr: _stderr, ...receipt} = data;
  const projected: ToolResult = {...result, data: receipt};
  if (projected.message === data.output || (data.output === '' && projected.message === 'exit 0')) delete projected.message;
  if (data.output && projected.error?.endsWith(`\n${data.output}`)) {
    projected.error = projected.error.slice(0, -data.output.length - 1);
  }
  return projected;
}

export interface ShellExecutionResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  started: boolean;
  terminationConfirmed: boolean;
  executionOutcome: 'succeeded' | 'failed' | 'unknown';
}

/** Environment inheritance is explicit. In particular no provider keys, PATs,
 * cloud credentials, loader flags, shell startup hooks, or arbitrary env vars. */
export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export async function runSupervisedShell(command: string, cwd: string, options: {
  timeoutMs?: number;
  context?: ToolExecutionContext;
  maxOutputBytes?: number;
  killGraceMs?: number;
} = {}): Promise<ShellExecutionResult> {
  const context = options.context;
  const timeout = Math.max(1, Math.min(options.timeoutMs ?? 30_000, 60_000));
  const maxBytes = options.maxOutputBytes ?? 64 * 1024;
  const grace = options.killGraceMs ?? 300;
  const base: ShellExecutionResult = {
    command, cwd, exitCode: null, signal: null, stdout: '', stderr: '', output: '',
    outputTruncated: false, timedOut: false, cancelled: false, started: false,
    terminationConfirmed: true, executionOutcome: 'failed',
  };
  if (context?.signal?.aborted || (context?.deadline !== undefined && context.deadline <= Date.now())) {
    return { ...base, cancelled: !!context?.signal?.aborted, timedOut: !context?.signal?.aborted, output: 'Command cancelled before dispatch' };
  }
  if (process.platform === 'win32') return { ...base, output: 'Supervised shell process groups are not supported on Windows' };
  return await new Promise<ShellExecutionResult>((resolve) => {
    // A non-login POSIX shell avoids sourcing user startup files into a tool run.
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: shellEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { ...base };
    let settled = false;
    let closed = false;
    let stopping = false;
    let totalBytes = 0;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settlement: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const groupAlive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* checked independently before settlement */ }
    };
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (settlement) clearTimeout(settlement);
      if (poll) clearInterval(poll);
      context?.signal?.removeEventListener('abort', abort);
      result.terminationConfirmed = confirmed;
      result.output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
      if (result.outputTruncated) result.output += '\n… output truncated';
      // A fully observed nonzero exit is a known command failure, not proof
      // of rollback. Preserve its output so a failed test can guide repairs.
      // A deadline the supervisor enforced itself, with the whole process group
      // confirmed dead, is likewise a known failure: the command did not finish,
      // its partial output is retained, and the model may narrow or retry it.
      // Only cancellation and unconfirmed termination stay unknown (CLI-048).
      result.executionOutcome = !result.started ? 'failed'
        : !stopping && confirmed && result.exitCode !== null
          ? result.exitCode === 0 ? 'succeeded' : 'failed'
          : result.timedOut && !result.cancelled && confirmed ? 'failed'
          : 'unknown';
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      signalGroup('SIGTERM');
      escalation = setTimeout(() => signalGroup('SIGKILL'), grace);
      poll = setInterval(() => { if (closed && !groupAlive()) finish(true); }, 20);
      settlement = setTimeout(() => { signalGroup('SIGKILL'); finish(closed && !groupAlive()); }, grace + 2_000);
    };
    const abort = () => { result.cancelled = true; stop(); };
    const deadlineDelay = context?.deadline === undefined ? timeout : Math.min(timeout, Math.max(1, context.deadline - Date.now()));
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, deadlineDelay);
    context?.signal?.addEventListener('abort', abort, { once: true });
    if (context?.signal?.aborted) abort();
    child.on('spawn', () => { result.started = true; if (stopping) signalGroup('SIGTERM'); });
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - totalBytes);
      const text = chunk.subarray(0, remaining).toString('utf8');
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) result.outputTruncated = true;
      result[stream] += text;
      // Observability must never change command execution semantics.
      if (text) { try { context?.onOutput?.({ stream, text }); } catch { /* observer only */ } }
    };
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.on('error', (error) => { result.stderr += error.message; closed = true; finish(!groupAlive()); });
    child.on('exit', (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      // A shell can exit while descendants hold its pipes or continue effects.
      if (groupAlive()) stop();
    });
    child.on('close', (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      closed = true;
      if (!groupAlive()) finish(true);
      else stop();
    });
  });
}
