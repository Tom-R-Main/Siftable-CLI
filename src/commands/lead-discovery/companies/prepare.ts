import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {asJsonObject} from '../../../lib/lead-discovery-contract.js';

interface PrepareResponse {prepared: Record<string, unknown>}

export default class LeadDiscoveryCompaniesPrepare extends BaseCommand {
  static description = 'Prepare an exact company-discovery quote without dispatching provider work';

  static flags = {
    ...BaseCommand.baseFlags,
    query: Flags.string({description: 'Exact lead-discovery query JSON object'}),
    'query-file': Flags.string({description: 'Path to an exact lead-discovery query JSON object'}),
    'target-kind': Flags.string({description: 'Discovery target kind', options: ['organization', 'organization_person'], default: 'organization'}),
    'idempotency-key': Flags.string({description: 'Stable retry key; generated when omitted'}),
  };

  async run(): Promise<PrepareResponse> {
    const {flags} = await this.parse(LeadDiscoveryCompaniesPrepare);
    const parsed = this.parseJsonInput<unknown>(flags.query, flags['query-file'], 'query');
    if (parsed === undefined) this.error('Provide --query or --query-file.');
    let query: Record<string, unknown>;
    try {
      query = asJsonObject(parsed, 'query');
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const idempotencyKey = flags['idempotency-key'] ?? this.idempotencyKey();
    const response = await this.apiRequest<PrepareResponse>(flags, '/api/v1/lead-discovery/commands/company/prepare', {
      method: 'POST',
      idempotencyKey,
      body: {targetKind: flags['target-kind'], idempotencyKey, query},
    });
    if (!this.jsonEnabled()) {
      const estimate = response.prepared.estimate as Record<string, unknown> | undefined;
      this.log(`Prepared ${String(response.prepared.preparedQueryId)} until ${String(response.prepared.expiresAt)}`);
      this.log(`Query digest: ${String(response.prepared.queryDigest)}`);
      this.log(`Maximum charge: ${String(estimate?.maximumChargeMicros ?? 'unknown')} micro-USD`);
      this.log('No provider search was dispatched.');
    }
    return response;
  }
}
