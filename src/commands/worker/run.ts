import {Flags} from '@oclif/core';
import {spawn} from 'node:child_process';
import {BaseCommand} from '../../lib/base-command.js';

function workInputContext(workItem: Record<string, unknown>): Record<string, unknown> {
  const context = workItem.inputContext;
  return context && typeof context === 'object' && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {};
}

const OUTPUT_TAIL_BYTES = 4000;

export function workerHeartbeatIntervalMs(leaseSeconds: number): number {
  return Math.max(10_000, Math.floor(leaseSeconds * 1000 / 3));
}

export function workerHeartbeatTimeoutMs(leaseSeconds: number): number {
  return Math.max(1_000, Math.floor(leaseSeconds * 1000 / 6));
}

export async function runHeartbeatWithDeadline(input: {
  heartbeat: () => Promise<void>;
  remainingLeaseMs: number;
  maxTimeoutMs: number;
}): Promise<void> {
  const timeoutMs = Math.max(1, Math.min(input.maxTimeoutMs, input.remainingLeaseMs - 1));
  if (input.remainingLeaseMs <= 1) {
    throw new Error('lease expired before heartbeat could start');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      input.heartbeat(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`heartbeat timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendTail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-OUTPUT_TAIL_BYTES);
}

export async function runShellWithHeartbeats(input: {
  shell: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseSeconds: number;
  heartbeat: () => Promise<void>;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}): Promise<{
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  leaseExpiresAtMs: number;
  errorMessage?: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.shell, ['-lc', input.command], {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutTail = '';
    let stderrTail = '';
    let heartbeatRunning = false;
    let heartbeatPromise: Promise<void> | null = null;
    let heartbeatFailure: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let leaseExpiresAtMs = Date.now() + input.leaseSeconds * 1000;
    const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? workerHeartbeatTimeoutMs(input.leaseSeconds);
    const signalWorkerTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
        if (code !== 'ESRCH') child.kill(signal);
      }
    };
    child.stdout?.on('data', (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); });
    child.stderr?.on('data', (chunk) => { stderrTail = appendTail(stderrTail, chunk); });

    const timer = setInterval(() => {
      if (heartbeatRunning || heartbeatFailure) return;
      heartbeatRunning = true;
      heartbeatPromise = runHeartbeatWithDeadline({
        heartbeat: input.heartbeat,
        remainingLeaseMs: leaseExpiresAtMs - Date.now(),
        maxTimeoutMs: heartbeatTimeoutMs,
      })
        .then(() => {
          leaseExpiresAtMs = Date.now() + input.leaseSeconds * 1000;
        })
        .catch((error: unknown) => {
          heartbeatFailure = error instanceof Error ? error : new Error(String(error));
          signalWorkerTree('SIGTERM');
          forceKillTimer = setTimeout(() => signalWorkerTree('SIGKILL'), 1_000);
          forceKillTimer.unref();
        })
        .finally(() => {
          heartbeatRunning = false;
          heartbeatPromise = null;
        });
    }, Math.max(1, Math.min(
      input.heartbeatIntervalMs ?? workerHeartbeatIntervalMs(input.leaseSeconds),
      Math.floor(input.leaseSeconds * 1000 / 3),
    )));
    timer.unref();

    child.once('error', (error) => {
      clearInterval(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', async (code, signal) => {
      clearInterval(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      await heartbeatPromise;
      if (heartbeatFailure) {
        reject(new Error(`Worker lease heartbeat failed: ${heartbeatFailure.message}`));
        return;
      }
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdoutTail,
        stderrTail,
        leaseExpiresAtMs,
        errorMessage: signal ? `Worker terminated by ${signal}.` : undefined,
      });
    });
  });
}

export default class WorkerRun extends BaseCommand {
  static description = 'Claim executable work, run a local worker command, and report needs-review artifacts';

  static flags = {
    ...BaseCommand.baseFlags,
    agent: Flags.string({description: 'Agent alias to claim work for', required: true}),
    owner: Flags.string({description: 'Worker owner fingerprint', required: true}),
    command: Flags.string({description: 'Local command to run for the claimed work item', required: true}),
    lease: Flags.integer({description: 'Lease seconds', default: 1800}),
    cwd: Flags.string({description: 'Fallback working directory for the local command'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkerRun);
    const client = await this.client(flags);
    const claim = await client.claimWorkItem({
      assignedAlias: flags.agent,
      claimOwner: flags.owner,
      leaseSeconds: flags.lease,
    });
    this.handleApiError(claim);
    const workItem = this.unwrapOne(claim, 'workItem');
    const claimToken = workItem.claimToken as string | undefined;
    const workItemId = workItem.id as string | undefined;
    if (!workItemId) {
      this.error('Claim response did not include a work item id.');
    }

    const start = await client.transitionWorkItem(workItemId, 'start', {
      claimOwner: flags.owner,
      claimToken,
      leaseSeconds: flags.lease,
    });
    this.handleApiError(start);

    const inputContext = workInputContext(workItem);
    const commandCwd = flags.cwd || (typeof inputContext.cwd === 'string' ? inputContext.cwd : process.cwd());
    const shell = process.env.SHELL || 'sh';
    const startedAt = Date.now();
    const runHeartbeat = async (): Promise<void> => {
      const heartbeat = await client.transitionWorkItem(workItemId, 'heartbeat', {
        claimOwner: flags.owner,
        claimToken,
        leaseSeconds: flags.lease,
      });
      this.handleApiError(heartbeat);
    };
    const result = await runShellWithHeartbeats({
      shell,
      command: flags.command,
      cwd: commandCwd,
      env: {
        ...process.env,
        SIFT_WORK_ITEM_ID: workItemId,
        SIFT_WORK_AGENT: flags.agent,
        SIFT_WORK_OWNER: flags.owner,
      },
      leaseSeconds: flags.lease,
      heartbeat: runHeartbeat,
    });
    const durationMs = Date.now() - startedAt;

    // Revalidate ownership immediately before the terminal review transition.
    await runHeartbeatWithDeadline({
      heartbeat: runHeartbeat,
      remainingLeaseMs: result.leaseExpiresAtMs - Date.now(),
      maxTimeoutMs: workerHeartbeatTimeoutMs(flags.lease),
    });

    const exitCode = result.exitCode;
    const summary = [
      `Worker ${flags.owner} ran \`${flags.command}\` for ${workItemId}.`,
      `Exit code: ${exitCode}. Duration: ${durationMs}ms.`,
      result.errorMessage ? `Error: ${result.errorMessage}` : '',
      result.stderrTail ? `stderr:\n${result.stderrTail.slice(-2000)}` : '',
    ].filter(Boolean).join('\n');
    const artifacts = [{
      type: 'worker_run',
      command: flags.command,
      cwd: commandCwd,
      exitCode,
      durationMs,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    }];

    const review = await client.transitionWorkItem(workItemId, 'review', {
      claimOwner: flags.owner,
      claimToken,
      resultSummary: summary,
      artifactRefs: artifacts,
      // Local worker runs do not inspect the diff for durable facts; explicit skip keeps the boundary honest.
      durableMemory: {
        decision: 'skip',
        rationale: 'Local worker run did not evaluate durable code-memory capture',
      },
    });
    this.handleApiError(review);
    const reviewed = this.unwrapOne(review, 'workItem');

    if (!this.jsonEnabled()) {
      this.log(`Work item needs review: ${reviewed.id}`);
      this.log(`Command exit code: ${exitCode}`);
    }

    return {
      workItem: reviewed,
      command: {
        command: flags.command,
        cwd: commandCwd,
        exitCode,
        durationMs,
      },
    };
  }
}
