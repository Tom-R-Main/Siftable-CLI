import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CalendarUpdate extends BaseCommand {
  static description = 'Update a calendar event';

  static args = {
    id: Args.string({description: 'Event ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Event title'}),
    start: Flags.string({description: 'Start time (ISO 8601)'}),
    end: Flags.string({description: 'End time (ISO 8601)'}),
    description: Flags.string({description: 'Event description'}),
    location: Flags.string({description: 'Event location'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CalendarUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.title !== undefined) updates.title = flags.title;
    if (flags.start !== undefined) updates.startTime = flags.start;
    if (flags.end !== undefined) updates.endTime = flags.end;
    if (flags.description !== undefined) updates.description = flags.description;
    if (flags.location !== undefined) updates.location = flags.location;

    const response = await client.updateCalendarEvent(args.id, updates);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Event ${args.id} updated`);
    }

    return response.data;
  }
}
