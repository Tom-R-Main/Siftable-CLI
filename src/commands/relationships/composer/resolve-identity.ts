import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerResolveIdentity extends BaseCommand {
  static description = 'Resolve or route the inline plausible-duplicate gate for one reviewed message';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ required: true, min: 1 }),
    candidate: Flags.string({ description: 'Candidate person UUID', required: true }),
    decision: Flags.string({ options: ['same_person', 'different_people', 'route_to_owner'], required: true }),
    yes: Flags.boolean({ description: 'Confirm the identity decision' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerResolveIdentity);
    if (!await this.confirmAction(`Record identity decision ${flags.decision}?`, flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/identity-resolution`,
      {
        method: 'POST',
        body: {
          expectedVersion: flags['expected-version'],
          candidatePersonId: flags.candidate,
          decision: flags.decision,
        },
      },
    );
    const review = response.session.review as Record<string, unknown> | null;
    const collision = review?.identityCollision as Record<string, unknown> | null;
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Identity state', collision?.status ?? 'clear'],
      ['Review digest', review?.digest ?? 'not available'],
    ]);
    return response.session;
  }
}
