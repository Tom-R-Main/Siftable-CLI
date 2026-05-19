import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class EventsList extends BaseCommand {
  static description = 'List research event timeline facts';

  static flags = {
    ...BaseCommand.baseFlags,
    person: Flags.string({description: 'Filter by person UUID'}),
    entity: Flags.string({description: 'Filter by entity ref type:uuid'}),
    start: Flags.string({description: 'Start boundary'}),
    end: Flags.string({description: 'End boundary'}),
    q: Flags.string({description: 'Text search query'}),
    order: Flags.string({description: 'Sort order', options: ['asc', 'desc'], default: 'asc'}),
    cursor: Flags.string({description: 'Pagination cursor'}),
    limit: Flags.integer({description: 'Maximum events', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EventsList);
    const entity = flags.entity ?? (flags.person ? `person:${flags.person}` : undefined);
    const client = await this.client(flags);
    const response = await client.listTimelineFacts({
      start: flags.start,
      end: flags.end,
      factTypes: ['event'],
      entity,
      q: flags.q,
      order: flags.order as 'asc' | 'desc',
      cursor: flags.cursor,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const items = (result.items ?? []) as Record<string, unknown>[];

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Count', items.length],
        ['Cursor', result.cursor],
      ]);
      this.log('');
      renderTable(items, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'timeLabel', header: 'Time'},
        {key: 'confidence', header: 'Confidence'},
      ]);
    }

    return result;
  }
}
