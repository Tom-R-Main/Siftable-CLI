import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsExport extends BaseCommand {
  static description = 'Export dataset records as CSV';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    filters: Flags.string({description: 'JSON array of filters'}),
    sorts: Flags.string({description: 'JSON array of sorts'}),
    limit: Flags.integer({description: 'Max rows to export', default: 500}),
    output: Flags.string({description: 'Output file path (writes to stdout if omitted)', char: 'o'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsExport);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {limit: flags.limit};
    if (flags.filters) options.filters = JSON.parse(flags.filters);
    if (flags.sorts) options.sorts = JSON.parse(flags.sorts);

    const response = await client.exportDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    const csv = data?.csv ?? '';

    if (flags.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(flags.output, csv);
      if (!this.jsonEnabled()) {
        this.log(`Exported ${data?.rowCount ?? 0} rows to ${flags.output}`);
      }
    } else if (!this.jsonEnabled()) {
      this.log(csv);
    }

    return response.data;
  }
}
