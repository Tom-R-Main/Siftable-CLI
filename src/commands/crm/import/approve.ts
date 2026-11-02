import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderCrmImportPlan} from '../../../lib/crm-import.js';

interface PlanResponse {plan: Record<string, unknown>}

export default class CrmImportApprove extends BaseCommand {
  static description = 'Approve all or selected pending operations in an existing CRM import plan';

  static args = {
    planId: Args.string({description: 'Durable CRM import plan UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reason: Flags.string({description: 'Human approval reason recorded on the plan', required: true}),
    'operation-id': Flags.string({description: 'Stable operation ID to approve; repeat to approve a subset', multiple: true}),
    yes: Flags.boolean({description: 'Confirm the approval without prompting'}),
  };

  async run(): Promise<PlanResponse | {cancelled: true}> {
    const {args, flags} = await this.parse(CrmImportApprove);
    const scope = flags['operation-id']?.length
      ? `${flags['operation-id'].length} selected operation(s)`
      : 'all eligible pending operations';
    const confirmed = await this.confirmAction(`Approve ${scope} in CRM import plan ${args.planId}?`, flags);
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<PlanResponse>(
      flags,
      `/api/v1/imports/crm/plans/${encodeURIComponent(args.planId)}/approve`,
      {
        method: 'POST',
        body: {
          reason: flags.reason,
          ...(flags['operation-id']?.length ? {operationIds: flags['operation-id']} : {}),
        },
      },
    );
    if (!this.jsonEnabled()) renderCrmImportPlan(response.plan);
    return response;
  }
}
