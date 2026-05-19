import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class PeopleTimeline extends BaseCommand {
  static description = 'List timeline facts connected to a person';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    order: Flags.string({description: 'Sort order', options: ['asc', 'desc'], default: 'asc'}),
    limit: Flags.integer({description: 'Maximum facts to return', default: 50}),
    role: Flags.string({description: 'Filter by entity role, comma-separated'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleTimeline);
    const client = await this.client(flags);
    const response = await client.listTimelineFacts({
      entity: `person:${args.id}`,
      entityRole: flags.role ? flags.role.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      order: flags.order as 'asc' | 'desc',
      limit: flags.limit,
    });
    this.handleApiError(response);
    const data = response.data as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
    const result = {
      ok: true,
      personId: args.id,
      items,
      cursor: data.cursor ?? null,
      meta: data.meta ?? {},
    };

    if (!this.jsonEnabled()) {
      renderTable(items, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'factType', header: 'Type'},
        {key: 'confidence', header: 'Confidence'},
      ]);
    }

    return result;
  }
}
