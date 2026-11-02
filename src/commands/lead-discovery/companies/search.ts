import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {asJsonObject} from '../../../lib/lead-discovery-contract.js';

interface PrepareResponse {prepared: Record<string, unknown>}
interface RunResponse {run: Record<string, unknown>}

export default class LeadDiscoveryCompaniesSearch extends BaseCommand {
  static description = 'Prepare and run a bounded company search under an explicit approved maximum charge';

  static flags = {
    ...BaseCommand.baseFlags,
    query: Flags.string({description: 'Exact lead-discovery query JSON object'}),
    'query-file': Flags.string({description: 'Path to an exact lead-discovery query JSON object'}),
    'maximum-charge-micros': Flags.string({description: 'Caller-approved charge ceiling in micro-USD', required: true}),
    'idempotency-key': Flags.string({description: 'Stable retry key; generated when omitted'}),
  };

  async run(): Promise<RunResponse> {
    const {flags} = await this.parse(LeadDiscoveryCompaniesSearch);
    if (!/^(0|[1-9]\d*)$/.test(flags['maximum-charge-micros'])) {
      this.error('--maximum-charge-micros must be a non-negative integer string.');
    }
    const parsed = this.parseJsonInput<unknown>(flags.query, flags['query-file'], 'query');
    if (parsed === undefined) this.error('Provide --query or --query-file.');
    let query: Record<string, unknown>;
    try {
      query = asJsonObject(parsed, 'query');
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const idempotencyKey = flags['idempotency-key'] ?? this.idempotencyKey();
    const prepared = await this.apiRequest<PrepareResponse>(flags, '/api/v1/lead-discovery/commands/company/prepare', {
      method: 'POST',
      idempotencyKey,
      body: {targetKind: 'organization', idempotencyKey, query},
    });
    const estimate = prepared.prepared.estimate as Record<string, unknown> | undefined;
    const quotedMaximum = estimate?.maximumChargeMicros;
    if (typeof quotedMaximum !== 'string' || !/^(0|[1-9]\d*)$/.test(quotedMaximum)) {
      this.error('Prepare returned an invalid maximum-charge contract.');
    }
    if (BigInt(quotedMaximum) > BigInt(flags['maximum-charge-micros'])) {
      this.error(`Prepared maximum charge ${quotedMaximum} exceeds approved ceiling ${flags['maximum-charge-micros']}; no provider search was dispatched.`);
    }
    const response = await this.apiRequest<RunResponse>(flags, '/api/v1/lead-discovery/commands/company/run', {
      method: 'POST',
      body: {
        preparedQueryId: prepared.prepared.preparedQueryId,
        expectedQueryDigest: prepared.prepared.queryDigest,
        approvedMaximumChargeMicros: quotedMaximum,
      },
    });
    if (!this.jsonEnabled()) {
      this.log(`Run ${String(response.run.runId)}: ${String(response.run.state)}`);
      this.log(`Quoted maximum: ${quotedMaximum}; actual charge: ${String(response.run.actualChargeMicros ?? 'pending')} micro-USD`);
      this.log('No canonical CRM record or prospect was created.');
    }
    return response;
  }
}
