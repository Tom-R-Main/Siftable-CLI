/**
 * The host Docker client the supervisor uses: no user PATH, no Docker config,
 * and a time bound on every call. A call made under an absolute deadline gets
 * only the time left before it, and none once it has passed, so a Stop's 10 s
 * budget holds across several Docker commands.
 */
import {execFile, spawn} from 'node:child_process';
import type {Attach, Docker} from './machineQualify.js';
import {type SupervisorClock, systemClock} from './superviseAuthority.js';

export const DOCKER_ENV = {PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_CONFIG: '/dev/null'};
/** Exit code reported for a call the deadline cut short or never started. */
export const DEADLINE_EXIT = 124;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface DockerCall {
  /** Monotonic time (SupervisorClock.monoMs) by which the call must have returned. */
  deadlineMono?: number;
}

export type DeadlineDocker = (args: string[], call?: DockerCall) => ReturnType<Docker>;

type Exec = (args: string[], timeoutMs: number) => ReturnType<Docker>;

const execDocker: Exec = (args, timeoutMs) => new Promise((resolve) => {
  execFile('docker', args, {env: DOCKER_ENV, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024},
    (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & {killed?: boolean; code?: unknown}) | null;
      const code = !failure ? 0 : failure.killed ? DEADLINE_EXIT : typeof failure.code === 'number' ? failure.code : 1;
      resolve({code, stdout: String(stdout), stderr: String(stderr)});
    });
});

export function createHostDocker(options: {clock?: SupervisorClock; exec?: Exec; defaultTimeoutMs?: number} = {}): DeadlineDocker {
  const clock = options.clock ?? systemClock;
  const exec = options.exec ?? execDocker;
  const ceiling = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (args, call) => {
    const remaining = call?.deadlineMono === undefined ? ceiling : Math.min(ceiling, Math.floor(call.deadlineMono - clock.monoMs()));
    if (remaining <= 0) return {code: DEADLINE_EXIT, stdout: '', stderr: 'deadline passed before the call'};
    return exec(args, remaining);
  };
}

export const hostAttach: Attach = (args) => {
  const child = spawn('docker', args, {env: DOCKER_ENV, stdio: ['pipe', 'pipe', 'ignore']});
  return {
    stdin: child.stdin, stdout: child.stdout,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1))),
    kill: () => { child.kill('SIGTERM'); },
  };
};
