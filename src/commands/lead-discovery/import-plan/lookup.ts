import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

interface ImportPlanResponse {importPlan: Record<string, unknown>}

export default class LeadDiscoveryImportPlanLookup extends BaseCommand {
  static description = 'Recover the import plan bound to a run and exact shortlist digest';
  static args = {runId: Args.string({description: 'Discovery run UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-shortlist-digest': Flags.string({description: 'Exact 64-character shortlist digest', required: true}),
  };

  async run(): Promise<ImportPlanResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryImportPlanLookup);
    if (!/^[0-9a-f]{64}$/.test(flags['expected-shortlist-digest'])) {
      this.error('--expected-shortlist-digest must be a lowercase 64-character hex digest.');
    }
    const response = await this.apiRequest<ImportPlanResponse>(
      flags,
      '/api/v1/lead-discovery/commands/import-plan/lookup',
      {
        method: 'POST',
        body: {
          runId: args.runId,
          expectedShortlistDigest: flags['expected-shortlist-digest'],
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Import plan ${String(response.importPlan.planId)} for run ${String(response.importPlan.runId)}`);
      this.log(`Shortlist digest: ${String(response.importPlan.shortlistDigest)}`);
    }
    return response;
  }
}
