import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CalendarDelete extends BaseCommand {
  static description = 'Delete a calendar event';

  static args = {
    id: Args.string({description: 'Event ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CalendarDelete);

    const confirmed = await this.confirmAction('Delete this event?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteCalendarEvent(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Event ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}
