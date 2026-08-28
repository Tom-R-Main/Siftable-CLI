import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

interface ImportPlanResponse {importPlan: Record<string, unknown>}

export default class LeadDiscoveryImportPlanCreate extends BaseCommand {
  static description = 'Create or recover the import plan bound to an exact reviewed shortlist';
  static args = {runId: Args.string({description: 'Discovery run UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    'candidate-id': Flags.string({description: 'Shortlisted candidate UUID; repeat for each candidate', multiple: true, required: true}),
    'expected-shortlist-digest': Flags.string({description: 'Exact 64-character shortlist digest', required: true}),
    'idempotency-key': Flags.string({description: 'Stable retry key; generated when omitted'}),
  };

  async run(): Promise<ImportPlanResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryImportPlanCreate);
    if (!/^[0-9a-f]{64}$/.test(flags['expected-shortlist-digest'])) {
      this.error('--expected-shortlist-digest must be a lowercase 64-character hex digest.');
    }
    const idempotencyKey = flags['idempotency-key'] ?? this.idempotencyKey();
    const response = await this.apiRequest<ImportPlanResponse>(
      flags,
      '/api/v1/lead-discovery/commands/import-plan/create',
      {
        method: 'POST',
        idempotencyKey,
        body: {
          runId: args.runId,
          candidateIds: flags['candidate-id'],
          expectedShortlistDigest: flags['expected-shortlist-digest'],
          idempotencyKey,
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Import plan ${String(response.importPlan.planId)} for run ${String(response.importPlan.runId)}${response.importPlan.reused ? ' (reused)' : ''}`);
      this.log(`Shortlist digest: ${String(response.importPlan.shortlistDigest)}`);
      this.log('No canonical CRM write was performed.');
    }
    return response;
  }
}
