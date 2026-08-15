import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderCrmImportPlan} from '../../../lib/crm-import.js';

interface PlanResponse {plan: Record<string, unknown>}

export default class CrmImportApply extends BaseCommand {
  static description = 'Apply only approved operations from an existing CRM import plan; replay is safe';

  static args = {
    planId: Args.string({description: 'Durable CRM import plan UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm canonical CRM writes without prompting'}),
  };

  async run(): Promise<PlanResponse | {cancelled: true}> {
    const {args, flags} = await this.parse(CrmImportApply);
    const confirmed = await this.confirmAction(
      `Apply approved operations from CRM import plan ${args.planId}?`,
      flags,
    );
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<PlanResponse>(
      flags,
      `/api/v1/imports/crm/plans/${encodeURIComponent(args.planId)}/apply`,
      {method: 'POST'},
    );
    if (!this.jsonEnabled()) renderCrmImportPlan(response.plan);
    return response;
  }
}
