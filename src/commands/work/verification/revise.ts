import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {formatVerificationPlan, type WorkVerificationPlanView} from '../../../lib/work-verification.js';

type VerificationStepInput = {
  key: string;
  title: string;
  kind: 'shell' | 'http' | 'cloud_run_job' | 'external';
  required?: boolean;
  spec: Record<string, unknown>;
  expectedOutcome: Record<string, unknown>;
  timeoutSeconds: number;
  environmentLabel: string;
};

export default class WorkVerificationRevise extends BaseCommand {
  static description = 'Create an audited active verification-plan revision';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({description: 'Observed active plan version', required: true, min: 1}),
    reason: Flags.string({description: 'Audited revision reason', required: true}),
    steps: Flags.string({description: 'Verification step JSON array'}),
    'steps-file': Flags.string({description: 'Path to a verification step JSON array'}),
    provenance: Flags.string({description: 'Revision provenance JSON object'}),
    yes: Flags.boolean({description: 'Confirm activation without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkVerificationRevise);
    const steps = this.parseJsonInput<VerificationStepInput[]>(
      flags.steps,
      flags['steps-file'],
      'steps',
    );
    if (!Array.isArray(steps)) this.error('A steps JSON array is required.');
    const provenance = this.parseJsonFlag<Record<string, unknown>>(flags.provenance, 'provenance');
    const confirmed = await this.confirmAction(
      `Activate verification plan v${flags['expected-version'] + 1} for ${args.id}?`,
      flags,
    );
    if (!confirmed) return {cancelled: true};

    const result = await this.apiRequest<{plan: WorkVerificationPlanView}>(
      flags,
      `/api/v1/work-items/${args.id}/verification-plan/revisions`,
      {
        method: 'POST',
        body: {
          expectedActiveVersion: flags['expected-version'],
          reason: flags.reason,
          provenance,
          steps,
        },
      },
    );
    if (!this.jsonEnabled()) this.log(formatVerificationPlan(result.plan));
    return result.plan;
  }
}
