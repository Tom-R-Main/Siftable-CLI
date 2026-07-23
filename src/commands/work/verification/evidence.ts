import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {formatVerificationPlan, type WorkVerificationPlanView} from '../../../lib/work-verification.js';

export default class WorkVerificationEvidence extends BaseCommand {
  static description = 'Submit externally executed evidence for an exact plan version and step ID';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'plan-version': Flags.integer({description: 'Active verification plan version', required: true, min: 1}),
    step: Flags.string({description: 'Stable verification step UUID', required: true}),
    attempt: Flags.string({description: 'Caller-stable attempt identity', required: true}),
    outcome: Flags.string({description: 'Attempt outcome', options: ['passed', 'failed', 'error'], required: true}),
    'exit-code': Flags.integer({description: 'Process exit code when applicable'}),
    output: Flags.string({description: 'Bounded output excerpt; secrets are redacted by the API'}),
    artifacts: Flags.string({description: 'Artifact reference JSON array for larger logs'}),
    environment: Flags.string({description: 'Execution environment label', required: true}),
    provenance: Flags.string({description: 'Evidence provenance JSON object'}),
    'ran-at': Flags.string({description: 'RFC3339 execution timestamp'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkVerificationEvidence);
    const artifactRefs = this.parseJsonFlag<unknown[]>(flags.artifacts, 'artifacts') ?? [];
    const provenance = this.parseJsonFlag<Record<string, unknown>>(flags.provenance, 'provenance');
    const result = await this.apiRequest<{
      attempt: Record<string, unknown>;
      plan: WorkVerificationPlanView;
    }>(flags, `/api/v1/work-items/${args.id}/verification-evidence`, {
      method: 'POST',
      body: {
        planVersion: flags['plan-version'],
        stepId: flags.step,
        attemptId: flags.attempt,
        outcome: flags.outcome,
        exitCode: flags['exit-code'],
        output: flags.output,
        artifactRefs,
        environmentLabel: flags.environment,
        provenance,
        ranAt: flags['ran-at'],
      },
    });
    if (!this.jsonEnabled()) {
      this.log(`Evidence recorded: ${String(result.attempt.attemptId ?? flags.attempt)}`);
      this.log(formatVerificationPlan(result.plan));
    }
    return result;
  }
}
