import {Flags} from '@oclif/core';
import {execFileSync} from 'node:child_process';
import {BaseCommand} from '../../lib/base-command.js';
import {
  AGENT_RUNTIME_DISPATCH_SURFACES,
  buildAgentRuntimeDispatchPlan,
  type AgentRuntimeDispatchSurface,
  type AgentRuntimeDispatchWorkItem,
} from '../../lib/agent-runtime/dispatch.js';

function gitOutput(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error('Unable to inspect the current Git checkout; run inside the reviewed checkout or pass --source-sha.');
  }
}

function currentGitSha(): string {
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('The current Git checkout is dirty; use a clean reviewed checkout or pass its exact SHA with --source-sha.');
  }
  return gitOutput(['rev-parse', 'HEAD']);
}

export default class WorkerDispatch extends BaseCommand {
  static description = 'Build a no-spend, surface-neutral plan for exactly two AWS agent workers';

  static flags = {
    ...BaseCommand.baseFlags,
    'work-item': Flags.string({
      description: 'Queued Sift work-item UUID; repeat exactly twice',
      multiple: true,
      required: true,
    }),
    surface: Flags.string({
      description: 'Calling control surface; does not change dispatch identity',
      options: [...AGENT_RUNTIME_DISPATCH_SURFACES],
      default: 'cli',
    }),
    'source-sha': Flags.string({description: 'Reviewed 40-character source Git SHA; defaults to a clean current HEAD'}),
    'max-runtime-minutes': Flags.integer({
      description: 'Per-worker runtime ceiling',
      min: 1,
      max: 120,
      default: 120,
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkerDispatch);
    if (flags['work-item'].length !== 2) this.error('Pass --work-item exactly twice.');
    const client = await this.client(flags);
    const workItems: AgentRuntimeDispatchWorkItem[] = [];
    for (const workItemId of flags['work-item']) {
      const response = await client.getWorkItem(workItemId);
      this.handleApiError(response);
      workItems.push(this.unwrapOne(response, 'workItem') as AgentRuntimeDispatchWorkItem);
    }
    const plan = buildAgentRuntimeDispatchPlan({
      requestedBySurface: flags.surface as AgentRuntimeDispatchSurface,
      sourceGitSha: flags['source-sha'] ?? currentGitSha(),
      maximumRuntimeMinutes: flags['max-runtime-minutes'],
      workItems,
    });

    if (!this.jsonEnabled()) {
      this.log(`Dispatch plan ${plan.dispatchId}`);
      this.log(`AWS ${plan.region} · ${plan.workerCount} On-Demand workers · ${plan.maximumInstanceHours} instance-hours maximum`);
      this.log(`Validated ${plan.workItems.map(item => item.id).join(' + ')}`);
      this.log('No claims, AWS resources, branches, or pull requests were created.');
    }
    return plan;
  }
}
