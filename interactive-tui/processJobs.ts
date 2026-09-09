import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { assertExecutionActive, type ToolExecutionContext } from './agent-harness/framework/execution-context';
import { shellEnvironment } from './shellExecution';

export interface ProcessJobSnapshot {
  jobId: string;
  command: string;
  cwd: string;
  status: 'running' | 'stopping' | 'exited' | 'stopped' | 'unknown';
  startedAt: number;
  expiresAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason?: 'requested' | 'cancelled' | 'expired' | 'shutdown' | 'leader_exited';
  terminationConfirmed: boolean;
  /** Byte offsets in the combined stdout/stderr stream; old output is evicted. */
  output: string;
  outputStart: number;
  nextOffset: number;
  totalOutputBytes: number;
  outputLost: boolean;
  more: boolean;
}

interface Job {
  snapshot: Omit<ProcessJobSnapshot, 'output' | 'outputStart' | 'nextOffset' | 'totalOutputBytes' | 'outputLost' | 'more'>;
  sessionId: string;
  workspaceRoot: string;
  scopeId?: string;
  child: ChildProcess;
  output: Buffer;
  totalBytes: number;
  closed: boolean;
  finished: boolean;
  cleanup: () => void;
  emergencyStop: () => void;
  stop: (reason: NonNullable<ProcessJobSnapshot['stopReason']>) => Promise<void>;
}

/** Live ownership only: never revive a PID from disk. A supervisor/container must
 * clean up after an uncatchable host crash. Commands must keep their service in
 * the foreground; when its shell exits, remaining process-group members stop. */
export class ProcessJobManager {
  private readonly jobs = new Map<string, Job>();
  private closing = false;
  private readonly onExit = () => {
    for (const job of this.jobs.values()) {
      if (!job.finished) job.emergencyStop();
    }
  };

  constructor(private readonly maxOutputBytes = 64 * 1024, private readonly killGraceMs = 300) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new Error('Invalid job output limit');
  }

  private owner(job: Job, context: ToolExecutionContext): void {
    if (job.sessionId !== context.sessionId || job.workspaceRoot !== realpathSync(context.workspaceRoot)
      || job.scopeId !== context.approval?.scopeId) throw new Error('Job is not owned by this session and authority scope');
  }

  private lookup(id: string, context: ToolExecutionContext): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job; jobs cannot be recovered after host restart');
    this.owner(job, context);
    return job;
  }

  async start(command: string, cwd: string, context: ToolExecutionContext, lifetimeMs = 60 * 60_000): Promise<ProcessJobSnapshot> {
    assertExecutionActive(context);
    if (this.closing) throw new Error('Process job manager is shutting down');
    if (process.platform === 'win32') throw new Error('Process jobs require POSIX process groups');
    if (!command.trim()) throw new Error('command is required');
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3 * 60 * 60_000) throw new Error('lifetimeMs must be between 1 and 10800000');
    const workspaceRoot = realpathSync(context.workspaceRoot);
    const directory = realpathSync(cwd);
    const childPath = relative(workspaceRoot, directory);
    if (childPath === '..' || childPath.startsWith('../') || isAbsolute(childPath)) throw new Error('Job cwd must be inside the authorized workspace');
    if ([...this.jobs.values()].filter(job => !job.finished && job.sessionId === context.sessionId).length >= 8) throw new Error('Session already owns eight active jobs');
    if (this.jobs.size >= 64) {
      for (const [id, job] of this.jobs) {
        if (job.finished) this.jobs.delete(id);
        if (this.jobs.size < 64) break;
      }
      if (this.jobs.size >= 64) throw new Error('Process job capacity reached');
    }
    const child = spawn('/bin/sh', ['-c', command], {cwd: directory, env: shellEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    const startedAt = Date.now();
    const expiresAt = Math.min(startedAt + lifetimeMs, context.deadline ?? Infinity);
    let settleAttempt: (() => void) | undefined;
    let attempt: Promise<void> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let settlement: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let spawned = false;
    let groupGone = false;
    const signal = context.lifetimeSignal ?? context.signal;
    const groupAlive = () => {
      if (!child.pid || groupGone) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupGone = true;
        return !groupGone;
      }
    };
    const signalGroup = (value: NodeJS.Signals) => {
      // Once disappearance has been observed, never signal this numeric group
      // again. Retrying retained live ownership does not resurrect a saved PID.
      if (spawned && child.pid && groupAlive()) { try { process.kill(-child.pid, value); } catch { /* confirmation is independent */ } }
    };
    const finish = (confirmed: boolean) => {
      if (job.finished) return;
      job.finished = confirmed;
      job.snapshot.terminationConfirmed = confirmed;
      job.snapshot.status = !confirmed ? 'unknown' : job.snapshot.stopReason ? 'stopped' : 'exited';
      clearTimeout(escalation); clearTimeout(settlement); clearInterval(poll);
      if (confirmed) {
        job.cleanup();
        child.stdout?.destroy(); child.stderr?.destroy();
        if (![...this.jobs.values()].some(item => !item.finished)) process.removeListener('exit', this.onExit);
      } else {
        // A bounded stop attempt can settle without releasing the job. Keep its
        // output, cancellation, exit hook and ownership until absence is seen.
        poll = setInterval(() => { if (job.closed && !groupAlive()) finish(true); }, 250);
        poll.unref();
      }
      const resolveAttempt = settleAttempt;
      attempt = undefined; settleAttempt = undefined;
      resolveAttempt?.();
    };
    const abort = () => { void job.stop('cancelled'); };
    const job: Job = {
      snapshot: {jobId: randomUUID(), command, cwd: directory, status: 'running', startedAt, expiresAt,
        exitCode: null, signal: null, terminationConfirmed: false},
      sessionId: context.sessionId, workspaceRoot, scopeId: context.approval?.scopeId,
      child, output: Buffer.alloc(0), totalBytes: 0, closed: false, finished: false,
      emergencyStop: () => signalGroup('SIGKILL'),
      cleanup: () => {
        clearTimeout(timer); clearTimeout(escalation); clearTimeout(settlement); clearInterval(poll);
        signal?.removeEventListener('abort', abort);
      },
      stop: async reason => {
        if (job.finished) return;
        if (!attempt) {
          attempt = new Promise<void>(resolve => { settleAttempt = resolve; });
          clearInterval(poll);
          job.snapshot.status = 'stopping'; job.snapshot.stopReason = reason;
          signalGroup('SIGTERM');
          escalation = setTimeout(() => signalGroup('SIGKILL'), this.killGraceMs);
          poll = setInterval(() => { if (job.closed && !groupAlive()) finish(true); }, 20);
          settlement = setTimeout(() => { signalGroup('SIGKILL'); finish(job.closed && !groupAlive()); }, this.killGraceMs + 2_000);
        }
        await attempt;
      },
    };
    this.jobs.set(job.snapshot.jobId, job);
    if (!process.listeners('exit').includes(this.onExit)) process.on('exit', this.onExit);
    const capture = (chunk: Buffer) => {
      job.totalBytes += chunk.byteLength;
      job.output = chunk.byteLength >= this.maxOutputBytes ? Buffer.from(chunk.subarray(-this.maxOutputBytes))
        : Buffer.concat([job.output, chunk]).subarray(-this.maxOutputBytes);
    };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.on('exit', (code, exitSignal) => {
      job.snapshot.exitCode = code; job.snapshot.signal = exitSignal;
      if (groupAlive()) void job.stop('leader_exited');
    });
    child.on('close', (code, exitSignal) => {
      job.closed = true; job.snapshot.exitCode = code; job.snapshot.signal = exitSignal;
      if (!groupAlive()) finish(true); else void job.stop('leader_exited');
    });
    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { spawned = true; if (job.snapshot.status === 'stopping') signalGroup('SIGTERM'); resolve(); });
      child.once('error', error => { job.closed = true; finish(!groupAlive()); reject(error); });
    });
    timer = setTimeout(() => { void job.stop('expired'); }, Math.max(1, expiresAt - Date.now()));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    await started;
    return this.read(job.snapshot.jobId, context);
  }

  read(id: string, context: ToolExecutionContext, offset = 0): ProcessJobSnapshot {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative byte offset');
    const job = this.lookup(id, context);
    if (offset > job.totalBytes) throw new Error('offset is beyond the current output');
    const retainedStart = job.totalBytes - job.output.byteLength;
    const outputStart = Math.max(offset, retainedStart);
    const bytes = job.output.subarray(outputStart - retainedStart, outputStart - retainedStart + 32 * 1024);
    const nextOffset = outputStart + bytes.byteLength;
    return {...job.snapshot, output: bytes.toString('utf8'), outputStart, nextOffset,
      totalOutputBytes: job.totalBytes, outputLost: offset < retainedStart, more: nextOffset < job.totalBytes};
  }

  list(context: ToolExecutionContext): ProcessJobSnapshot[] {
    return [...this.jobs.values()].filter(job => {
      try { this.owner(job, context); return true; } catch { return false; }
    }).map(job => this.read(job.snapshot.jobId, context, job.totalBytes));
  }

  async stop(id: string, context: ToolExecutionContext): Promise<ProcessJobSnapshot> {
    const job = this.lookup(id, context);
    await job.stop('requested');
    return this.read(id, context);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.jobs.values()].map(job => job.stop('shutdown')));
    if ([...this.jobs.values()].some(job => !job.snapshot.terminationConfirmed)) throw new Error('Process job cleanup could not be confirmed');
    process.removeListener('exit', this.onExit);
  }

  /** Host cancellation is session-wide, including jobs created in older turns. */
  async stopSession(sessionId: string): Promise<void> {
    const owned = [...this.jobs.values()].filter(job => job.sessionId === sessionId);
    await Promise.all(owned.map(job => job.stop('cancelled')));
    if (owned.some(job => !job.snapshot.terminationConfirmed)) throw new Error('Cancelled session job cleanup could not be confirmed');
  }
}
