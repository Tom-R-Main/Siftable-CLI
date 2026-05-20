import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, formatDate} from '../../lib/output.js';

export default class DatasetsList extends BaseCommand {
  static description = 'List datasets';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsList);
    const client = await this.client(flags);
    const response = await client.listDatasets(flags.limit);
    this.handleApiError(response);

    const datasets = this.unwrapList(response, 'datasets');
    const result = {
      ok: true,
      datasets,
    };

    if (!this.jsonEnabled()) {
      renderTable(datasets, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'rowCount', header: 'Rows', get: (r) => String(r.rowCount ?? 0)},
        {key: 'updatedAt', header: 'Updated', get: (r) => formatDate(r.updatedAt as string)},
      ]);
    }

    return result;
  }
}
