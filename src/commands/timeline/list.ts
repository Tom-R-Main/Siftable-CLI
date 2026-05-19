import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {splitCsvFlag} from '../../lib/entity-ref.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class TimelineList extends BaseCommand {
  static description = 'List timeline facts with bounded filters';

  static flags = {
    ...BaseCommand.baseFlags,
    start: Flags.string({description: 'Start boundary, ISO timestamp or supported historical boundary'}),
    end: Flags.string({description: 'End boundary, ISO timestamp or supported historical boundary'}),
    'fact-types': Flags.string({description: 'Comma-separated fact types'}),
    'source-types': Flags.string({description: 'Comma-separated source types'}),
    entity: Flags.string({description: 'Entity filter as type:uuid'}),
    'entity-role': Flags.string({description: 'Comma-separated entity roles'}),
    q: Flags.string({description: 'Text search query'}),
    order: Flags.string({description: 'Sort order', options: ['asc', 'desc'], default: 'asc'}),
    cursor: Flags.string({description: 'Pagination cursor'}),
    limit: Flags.integer({description: 'Maximum items to return', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TimelineList);
    const client = await this.client(flags);
    const response = await client.listTimelineFacts({
      start: flags.start,
      end: flags.end,
      factTypes: splitCsvFlag(flags['fact-types']),
      sourceTypes: splitCsvFlag(flags['source-types']),
      entity: flags.entity,
      entityRole: splitCsvFlag(flags['entity-role']),
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
        {key: 'factType', header: 'Type'},
        {key: 'timeLabel', header: 'Time'},
        {key: 'confidence', header: 'Confidence'},
      ]);
    }

    return result;
  }
}
