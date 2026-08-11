import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

const ACTIONS = ['explain', 'preview', 'accept', 'reject', 'undo'];

export default class RelationshipsComposerFindingAction extends BaseCommand {
  static description = 'Explain, preview, accept, reject, or undo an attributable coaching finding';
  static args = {
    id: Args.string({ description: 'Composer session UUID', required: true }),
    finding: Args.string({ description: 'Coaching finding UUID', required: true }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    action: Flags.string({ options: ACTIONS, required: true }),
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    yes: Flags.boolean({ description: 'Confirm a mutating coaching decision' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerFindingAction);
    if (['accept', 'reject', 'undo'].includes(flags.action)) {
      const confirmed = await this.confirmAction(`${flags.action} coaching finding ${args.finding}?`, flags);
      if (!confirmed) return { cancelled: true };
    }
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/coaching/findings/${encodeURIComponent(args.finding)}/action`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'], action: flags.action } },
    );
    const findings = Array.isArray(response.session.findings)
      ? response.session.findings as Record<string, unknown>[]
      : [];
    const finding = findings.find((entry) => entry.id === args.finding);
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Action', flags.action],
      ['Finding status', finding?.status ?? 'not returned'],
      ['Draft revision', (response.session.draft as Record<string, unknown> | null)?.revision ?? 'not created'],
    ]);
    return response.session;
  }
}
