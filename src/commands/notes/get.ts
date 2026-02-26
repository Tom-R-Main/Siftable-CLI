import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, formatDate} from '../../lib/output.js';

export default class NotesGet extends BaseCommand {
  static description = 'Get a note with full content';

  static args = {
    id: Args.string({description: 'Note ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(NotesGet);
    const client = await this.client(flags);
    const response = await client.getNote(args.id);
    this.handleApiError(response);

    const note = this.unwrapOne(response, 'note');

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', note.id],
        ['Title', note.title],
        ['Type', note.noteType],
        ['Project', note.projectId],
        ['Created', formatDate(note.createdAt as string)],
        ['Updated', formatDate(note.updatedAt as string)],
      ]);
      if (note.content) {
        this.log('\n---\n');
        this.log(note.content as string);
      }
    }

    return response.data;
  }
}
