import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

interface RunResponse {run: Record<string, unknown>}

export default class LeadDiscoveryRunsGet extends BaseCommand {
  static description = 'Recover durable discovery run status and receipt by stable run ID';
  static args = {runId: Args.string({description: 'Discovery run UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<RunResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryRunsGet);
    const response = await this.apiRequest<RunResponse>(
      flags,
      `/api/v1/lead-discovery/runs/${encodeURIComponent(args.runId)}`,
    );
    if (!this.jsonEnabled()) {
      this.log(`Run ${String(response.run.runId)}: ${String(response.run.state)}`);
      this.log(`Candidates: ${String(response.run.resultCount)}; actual charge: ${String(response.run.actualChargeMicros ?? 'pending')} micro-USD`);
    }
    return response;
  }
}
