import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, formatDateTime} from '../../lib/output.js';

export default class CalendarList extends BaseCommand {
  static description = 'List calendar events';

  static flags = {
    ...BaseCommand.baseFlags,
    start: Flags.string({description: 'Start date (ISO 8601)'}),
    end: Flags.string({description: 'End date (ISO 8601)'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CalendarList);
    const client = await this.client(flags);

    // Default to today through 7 days from now
    const now = new Date();
    const weekFromNow = new Date(now);
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    const startDate = flags.start ?? now.toISOString();
    const endDate = flags.end ?? weekFromNow.toISOString();

    const response = await client.listCalendarEvents({
      startDate,
      endDate,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const events = this.unwrapList(response, 'events');

    if (!this.jsonEnabled()) {
      renderTable(events, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'startTime', header: 'Start', get: (r) => formatDateTime(r.startTime as string)},
        {key: 'endTime', header: 'End', get: (r) => formatDateTime(r.endTime as string)},
        {key: 'location', header: 'Location'},
      ]);
    }

    return events;
  }
}
