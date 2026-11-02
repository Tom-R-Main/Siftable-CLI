import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseCrmImportFile, renderCrmImportPlan} from '../../../lib/crm-import.js';

interface CreatePlanResponse {
  plan: Record<string, unknown>;
  reused: boolean;
}

export default class CrmImportPlan extends BaseCommand {
  static description = 'Create or reuse a durable CRM import plan from CSV, TSV, XLS, or XLSX without writing canonical CRM records';

  static args = {
    file: Args.string({description: 'Local CSV, TSV, XLS, or XLSX source (8 MiB maximum)', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    provider: Flags.string({description: 'Source provider mapping', options: ['generic', 'salesforce'], default: 'generic'}),
    'mapping-mode': Flags.string({
      description: 'Manual mapping or approved workspace mapping profile',
      options: ['manual', 'workspace_auto'],
      default: 'manual',
    }),
  };

  static examples = [
    '<%= config.bin %> crm import plan contacts.csv --json',
    '<%= config.bin %> crm import plan accounts.xlsx --provider salesforce --workspace <workspace-id>',
  ];

  async run(): Promise<CreatePlanResponse> {
    const {args, flags} = await this.parse(CrmImportPlan);
    let source;
    try {
      source = parseCrmImportFile(args.file);
    } catch (error) {
      this.error(error instanceof Error ? error : new Error(String(error)));
    }
    const response = await this.apiRequest<CreatePlanResponse>(flags, '/api/v1/imports/crm/plans', {
      method: 'POST',
      body: {
        provider: flags.provider,
        mappingMode: flags['mapping-mode'],
        source,
      },
    });
    if (!this.jsonEnabled()) {
      renderCrmImportPlan(response.plan, response.reused);
      console.log('');
      console.log('Planning only. Review duplicate and conflict decisions, then approve before apply.');
    }
    return response;
  }
}
