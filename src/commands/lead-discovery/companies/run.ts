import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

interface RunResponse {run: Record<string, unknown>}

export default class LeadDiscoveryCompaniesRun extends BaseCommand {
  static description = 'Run one exact opaque prepared company-discovery contract';

  static args = {
    preparedQueryId: Args.string({description: 'Opaque prepared-query UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'query-digest': Flags.string({description: 'Exact digest returned by prepare', required: true}),
    'approved-maximum-charge-micros': Flags.string({description: 'Exact maximum charge returned by prepare and approved by the caller', required: true}),
  };

  async run(): Promise<RunResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryCompaniesRun);
    if (!/^[0-9a-f]{64}$/.test(flags['query-digest'])) {
      this.error('--query-digest must be a lowercase SHA-256 digest.');
    }
    if (!/^(0|[1-9]\d*)$/.test(flags['approved-maximum-charge-micros'])) {
      this.error('--approved-maximum-charge-micros must be a non-negative integer string.');
    }
    const response = await this.apiRequest<RunResponse>(flags, '/api/v1/lead-discovery/commands/company/run', {
      method: 'POST',
      body: {
        preparedQueryId: args.preparedQueryId,
        expectedQueryDigest: flags['query-digest'],
        approvedMaximumChargeMicros: flags['approved-maximum-charge-micros'],
      },
    });
    if (!this.jsonEnabled()) {
      this.log(`Run ${String(response.run.runId)}: ${String(response.run.state)}`);
      this.log(`Candidates: ${String(response.run.resultCount)}; actual charge: ${String(response.run.actualChargeMicros ?? 'pending')} micro-USD`);
      this.log('No canonical CRM record or prospect was created.');
    }
    return response;
  }
}
