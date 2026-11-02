import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../../../lib/relationship-command-input.js';

export default class RelationshipsComposerUpdate extends BaseCommand {
  static description = 'Update bound intent and ranked evidence before draft creation';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'JSON file with expectedVersion, brief, and evidence', required: true }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerUpdate);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}`,
      { method: 'PATCH', body: readJsonObject(flags.file, 'relationship composer update') },
    );
    if (!this.jsonEnabled()) renderDetail([['Session', response.session.id], ['Version', response.session.version]]);
    return response.session;
  }
}
