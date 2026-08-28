import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {sanitizeTerminalLine} from '../../../lib/output.js';

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
      this.log(`Organization ${sanitizeTerminalLine(response.origin.organizationId)} originated from run ${sanitizeTerminalLine(response.origin.runId)}`);
      this.log(`Candidate: ${sanitizeTerminalLine(response.origin.candidateId)}; import plan: ${sanitizeTerminalLine(response.origin.importPlanId)}`);
      this.log(`Provider evidence: ${sanitizeTerminalLine(response.origin.provider)} record ${sanitizeTerminalLine(response.origin.providerRecordId)}`);
    }
    return response;
  }
}
