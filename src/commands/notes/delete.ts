import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class NotesDelete extends BaseCommand {
  static description = 'Delete a note';

  static args = {
    id: Args.string({description: 'Note ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(NotesDelete);

    const confirmed = await this.confirmAction('Delete this note?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteNote(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Note ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}
