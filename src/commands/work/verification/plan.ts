import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {formatVerificationPlan, type WorkVerificationPlanView} from '../../../lib/work-verification.js';

export default class WorkVerificationPlan extends BaseCommand {
  static description = 'Show the active versioned verification plan and coverage';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkVerificationPlan);
    const result = await this.apiRequest<{plan: WorkVerificationPlanView}>(
      flags,
      `/api/v1/work-items/${args.id}/verification-plan`,
    );
    if (!this.jsonEnabled()) this.log(formatVerificationPlan(result.plan));
    return result.plan;
  }
}
