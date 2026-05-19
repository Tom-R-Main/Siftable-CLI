import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {splitCsvFlag} from '../../lib/entity-ref.js';
import {renderTable} from '../../lib/output.js';

export default class GraphSearch extends BaseCommand {
  static description = 'Search linkable entities for graph work';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    types: Flags.string({description: 'Comma-separated entity types'}),
    limit: Flags.integer({description: 'Maximum results', default: 20}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GraphSearch);
    const client = await this.client(flags);
    const response = await client.searchEntities(args.query, {
      types: splitCsvFlag(flags.types),
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderTable((result.results ?? []) as Record<string, unknown>[], [
        {key: 'entityType', header: 'Type'},
        {key: 'entityId', header: 'ID'},
        {key: 'label', header: 'Label'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
