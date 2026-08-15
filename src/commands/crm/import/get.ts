import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderCrmImportPlan} from '../../../lib/crm-import.js';

interface PlanResponse {plan: Record<string, unknown>}

export default class CrmImportGet extends BaseCommand {
  static description = 'Resume and inspect a durable CRM import plan by stable plan ID';

  static args = {
    planId: Args.string({description: 'Durable CRM import plan UUID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<PlanResponse> {
    const {args, flags} = await this.parse(CrmImportGet);
    const response = await this.apiRequest<PlanResponse>(
      flags,
      `/api/v1/imports/crm/plans/${encodeURIComponent(args.planId)}`,
    );
    if (!this.jsonEnabled()) renderCrmImportPlan(response.plan);
    return response;
  }
}
