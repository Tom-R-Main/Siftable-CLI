import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class NotesUpdate extends BaseCommand {
  static description = 'Update a note';

  static args = {
    id: Args.string({description: 'Note ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Note title'}),
    content: Flags.string({description: 'Note content (markdown)'}),
    type: Flags.string({
      description: 'Note type',
      options: ['note', 'concept', 'meeting', 'reference', 'daily', 'dataset'],
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(NotesUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.title !== undefined) updates.title = flags.title;
    if (flags.content !== undefined) updates.content = flags.content;
    if (flags.type !== undefined) updates.noteType = flags.type;

    const response = await client.updateNote(args.id, updates, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Note ${args.id} updated`);
    }

    return response.data;
  }
}
