import {Flags} from '@oclif/core';
import {spawnSync} from 'node:child_process';
import {BaseCommand} from '../../lib/base-command.js';

function workInputContext(workItem: Record<string, unknown>): Record<string, unknown> {
  const context = workItem.inputContext;
  return context && typeof context === 'object' && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {};
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
    const result = spawnSync(shell, ['-lc', flags.command], {
      cwd: commandCwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        SIFT_WORK_ITEM_ID: workItemId,
        SIFT_WORK_AGENT: flags.agent,
        SIFT_WORK_OWNER: flags.owner,
      },
      maxBuffer: 1024 * 1024,
    });
    const durationMs = Date.now() - startedAt;

    const heartbeat = await client.transitionWorkItem(workItemId, 'heartbeat', {
      claimOwner: flags.owner,
      claimToken,
      leaseSeconds: flags.lease,
    });
    this.handleApiError(heartbeat);

    const exitCode = typeof result.status === 'number' ? result.status : 1;
    const summary = [
      `Worker ${flags.owner} ran \`${flags.command}\` for ${workItemId}.`,
      `Exit code: ${exitCode}. Duration: ${durationMs}ms.`,
      result.error ? `Error: ${result.error.message}` : '',
      result.stderr ? `stderr:\n${result.stderr.slice(-2000)}` : '',
    ].filter(Boolean).join('\n');
    const artifacts = [{
      type: 'worker_run',
      command: flags.command,
      cwd: commandCwd,
      exitCode,
      durationMs,
      stdoutTail: result.stdout?.slice(-4000) ?? '',
      stderrTail: result.stderr?.slice(-4000) ?? '',
    }];

    const review = await client.transitionWorkItem(workItemId, 'review', {
      claimOwner: flags.owner,
      claimToken,
      resultSummary: summary,
      artifactRefs: artifacts,
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
