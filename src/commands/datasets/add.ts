import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsAdd extends BaseCommand {
  static description = 'Add records to a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    record: Flags.string({
      description: 'Record as JSON object, e.g. \'{"name":"Alice","age":"30"}\'',
      multiple: true,
    }),
    records: Flags.string({
      description: 'Multiple records as JSON array',
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsAdd);
    const client = await this.client(flags);

    let records: Array<{fields: Record<string, unknown>}> = [];

    if (flags.records) {
      try {
        const parsed = JSON.parse(flags.records);
        records = (Array.isArray(parsed) ? parsed : [parsed]).map(
          (r: Record<string, unknown>) => ({fields: r}),
        );
      } catch {
        this.error('Invalid --records JSON. Expected array of objects.');
      }
    }

    if (flags.record) {
      for (const r of flags.record) {
        try {
          records.push({fields: JSON.parse(r)});
        } catch {
          this.error(`Invalid --record JSON: ${r}`);
        }
      }
    }

    if (records.length === 0) {
      this.error('Provide records with --record or --records.');
    }

    const response = await client.mutateDataset(args.id, {
      operation: 'create',
      records,
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Added ${records.length} record(s) to dataset ${args.id}`);
    }

    return response.data;
  }
}
