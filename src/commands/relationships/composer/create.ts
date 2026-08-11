import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { parseEntityRef } from '../../../lib/entity-ref.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../../../lib/relationship-command-input.js';

export default class RelationshipsComposerCreate extends BaseCommand {
  static description = 'Create or resume a durable relationship brief-to-draft session';
  static args = {
    subject: Args.string({ description: 'Subject as prospect:uuid or opportunity:uuid', required: true }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'JSON file with source, recommendation, brief, and ranked evidence', required: true }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerCreate);
    const parsed = parseEntityRef(args.subject);
    if (!['prospect', 'opportunity'].includes(parsed.entityType)) this.error('Subject must be prospect:uuid or opportunity:uuid.');
    const input = readJsonObject(flags.file, 'relationship composer seed');
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      '/api/v1/relationships/composer-sessions',
      { method: 'POST', body: { ...input, subject: { kind: parsed.entityType, id: parsed.entityId } } },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Phase', response.session.phase],
      ['Version', response.session.version],
      ['Next', `sift relationships composer show ${String(response.session.id)}`],
    ]);
    return response.session;
  }
}
