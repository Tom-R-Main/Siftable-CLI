import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../../../lib/relationship-command-input.js';

export default class RelationshipsComposerSaveDraft extends BaseCommand {
  static description = 'Save a new durable revision of a relationship draft';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'JSON file with expectedVersion, subject, and bodyText', required: true }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerSaveDraft);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/draft`,
      { method: 'PATCH', body: readJsonObject(flags.file, 'relationship draft revision') },
    );
    const draft = response.session.draft as Record<string, unknown> | null;
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Revision', draft?.revision ?? 'not created'],
      ['Revision ID', draft?.revisionId ?? 'not created'],
    ]);
    return response.session;
  }
}
