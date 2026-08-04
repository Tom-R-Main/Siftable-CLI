import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderTable} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsProposalsList extends BaseCommand {
  static description = 'List meeting-derived relationship proposals and their review lifecycle';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({
      description: 'Filter by lifecycle status',
      options: ['pending', 'approved', 'rejected', 'committed', 'failed', 'stale'],
    }),
    'subject-kind': Flags.string({description: 'Filter by subject kind', options: ['prospect', 'opportunity']}),
    'subject-id': Flags.string({description: 'Filter by subject UUID'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipMeetingsProposalsList);
    if ((flags['subject-kind'] && !flags['subject-id']) || (!flags['subject-kind'] && flags['subject-id'])) {
      this.error('Provide --subject-kind and --subject-id together.');
    }
    const query = new URLSearchParams();
    if (flags.status) query.set('status', flags.status);
    if (flags['subject-kind']) query.set('subjectKind', flags['subject-kind']);
    if (flags['subject-id']) query.set('subjectId', flags['subject-id']);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await this.apiRequest<{proposals: Record<string, unknown>[]}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/proposals${suffix}`,
    );
    const proposals = response.proposals ?? [];
    if (!this.jsonEnabled()) {
      renderTable(proposals, [
        {key: 'proposalId', header: 'Proposal'},
        {
          key: 'action',
          header: 'Action',
          get: (row) => String((row.action as Record<string, unknown> | undefined)?.actionId ?? '—'),
        },
        {key: 'status', header: 'Status'},
        {key: 'createdAt', header: 'Created'},
      ]);
    }
    return response;
  }
}
