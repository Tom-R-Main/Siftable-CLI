import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CalendarCreate extends BaseCommand {
  static description = 'Create a calendar event';

  static examples = [
    '<%= config.bin %> calendar create --title "Team standup" --start 2026-03-01T09:00:00Z --end 2026-03-01T09:30:00Z',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Event title', required: true}),
    start: Flags.string({description: 'Start time (ISO 8601)', required: true}),
    end: Flags.string({description: 'End time (ISO 8601)', required: true}),
    description: Flags.string({description: 'Event description'}),
    location: Flags.string({description: 'Event location'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CalendarCreate);
    const client = await this.client(flags);
    const response = await client.createCalendarEvent({
      title: flags.title,
      startTime: flags.start,
      endTime: flags.end,
      description: flags.description,
      location: flags.location,
    });
    this.handleApiError(response);

    const event = this.unwrapOne(response, 'event');

    if (!this.jsonEnabled()) {
      this.log(`Event created: ${event.id}`);
    }

    return response.data;
  }
}
