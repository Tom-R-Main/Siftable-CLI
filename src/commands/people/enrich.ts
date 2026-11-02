import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

interface PersonEnrichmentResponse {
  success: boolean;
  mode?: 'standard' | 'ultra';
  profile?: {facts?: unknown[]};
  summary?: string;
  datasetDiffPlan?: {plan?: {id?: string; status?: string}};
  datasetDiffPlanError?: string;
}

export default class PeopleEnrich extends BaseCommand {
  static description = 'Research public information about a person with replay-safe execution';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    mode: Flags.string({
      description: 'Research depth',
      options: ['standard', 'ultra'],
      default: 'standard',
    }),
    dataset: Flags.string({description: 'Optional dataset ID for a reviewable reconciliation plan'}),
    'dataset-upsert-by': Flags.string({description: 'Preferred dataset identity field'}),
    'idempotency-key': Flags.string({
      description: 'Stable 8-128 character key for exact retries',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleEnrich);
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(flags['idempotency-key'])) {
      this.error('--idempotency-key must contain 8-128 letters, numbers, dots, colons, underscores, or hyphens.');
    }

    const result = await this.apiRequest<PersonEnrichmentResponse>(
      flags,
      `/api/v1/people/${encodeURIComponent(args.id)}/enrich`,
      {
        method: 'POST',
        idempotencyKey: flags['idempotency-key'],
        body: {
          mode: flags.mode,
          ...(flags.dataset ? {datasetId: flags.dataset} : {}),
          ...(flags['dataset-upsert-by'] ? {datasetUpsertBy: flags['dataset-upsert-by']} : {}),
        },
      },
    );

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Person', args.id],
        ['Research depth', result.mode ?? flags.mode],
        ['Facts found', result.profile?.facts?.length ?? 0],
        ['Dataset plan', result.datasetDiffPlan?.plan?.status ?? result.datasetDiffPlanError ?? '-'],
      ]);
      if (result.summary) this.log(`\n${result.summary}`);
    }
    return result;
  }
}
