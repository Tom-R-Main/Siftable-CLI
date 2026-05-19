import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class DatasetsFacets extends BaseCommand {
  static description = 'Show bounded facet summaries for dataset fields';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fields: Flags.string({description: 'Comma-separated field names to facet'}),
    limit: Flags.integer({description: 'Maximum values per facet', default: 20}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsFacets);
    const client = await this.client(flags);
    const response = await client.facetDataset(args.id, {
      fields: flags.fields?.split(',').map((field: string) => field.trim()).filter(Boolean),
      limitPerFacet: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      const rows = ((result.facets ?? []) as Array<Record<string, unknown>>).flatMap((facet) => {
        if (Array.isArray(facet.options)) {
          return facet.options.map((option: Record<string, unknown>) => ({
            field: facet.field,
            type: facet.fieldType,
            value: option.value,
            count: option.count,
          }));
        }
        const range = facet.range as Record<string, unknown> | undefined;
        return [{
          field: facet.field,
          type: facet.fieldType,
          value: range ? `${range.min ?? '—'}..${range.max ?? '—'}` : '—',
          count: '—',
        }];
      });

      renderTable(rows, [
        {key: 'field', header: 'Field'},
        {key: 'type', header: 'Type'},
        {key: 'value', header: 'Value/range'},
        {key: 'count', header: 'Count'},
      ]);
    }

    return result;
  }
}
