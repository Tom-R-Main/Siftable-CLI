import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {formatVerificationPlan, type WorkVerificationPlanView} from '../../../lib/work-verification.js';

export default class WorkVerificationHistory extends BaseCommand {
  static description = 'List immutable verification-plan history and coverage';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkVerificationHistory);
    const result = await this.apiRequest<{plans: WorkVerificationPlanView[]}>(
      flags,
      `/api/v1/work-items/${args.id}/verification-plan/history`,
    );
    if (!this.jsonEnabled()) {
      if (result.plans.length === 0) this.log('No verification plans found.');
      for (const plan of result.plans) {
        this.log(formatVerificationPlan(plan));
        this.log('');
      }
    }
    return result.plans;
  }
}
