import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

interface CandidatesResponse {
  candidates: Array<Record<string, unknown>>;
  shortlist?: {candidateIds: string[]; digest: string};
}

export default class LeadDiscoveryCandidatesList extends BaseCommand {
  static description = 'List source-backed review candidates for a durable discovery run';
  static args = {runId: Args.string({description: 'Discovery run UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<CandidatesResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryCandidatesList);
    const response = await this.apiRequest<CandidatesResponse>(
      flags,
      `/api/v1/lead-discovery/runs/${encodeURIComponent(args.runId)}/candidates`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.candidates, [
        {key: 'id', header: 'Candidate ID'},
        {key: 'state', header: 'State'},
        {key: 'reviewVersion', header: 'Version'},
        {key: 'provider', header: 'Provider'},
      ]);
      if (response.shortlist) {
        this.log(`Shortlist digest: ${response.shortlist.digest}`);
        this.log(`Shortlisted candidate IDs: ${response.shortlist.candidateIds.join(', ') || '(none)'}`);
      }
    }
    return response;
  }
}
