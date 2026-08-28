import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

interface OriginResponse {origin: Record<string, unknown>}

export default class LeadDiscoveryOriginGet extends BaseCommand {
  static description = 'Get persisted discovery-origin evidence for an imported organization';
  static args = {organizationId: Args.string({description: 'Organization UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<OriginResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryOriginGet);
    const response = await this.apiRequest<OriginResponse>(
      flags,
      `/api/v1/lead-discovery/organizations/${encodeURIComponent(args.organizationId)}/origin`,
    );
    if (!this.jsonEnabled()) {
      this.log(`Organization ${String(response.origin.organizationId)} originated from run ${String(response.origin.runId)}`);
      this.log(`Candidate: ${String(response.origin.candidateId)}; import plan: ${String(response.origin.importPlanId)}`);
      this.log(`Provider evidence: ${String(response.origin.provider)} record ${String(response.origin.providerRecordId)}`);
    }
    return response;
  }
}
