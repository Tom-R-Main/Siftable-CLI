import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsUpdateRecord extends BaseCommand {
  static description = 'Update a record in a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
    'record-id': Args.string({description: 'Record ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fields: Flags.string({
      description: 'Field updates as JSON object, e.g. \'{"status":"done"}\'',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsUpdateRecord);
    const client = await this.client(flags);

    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(flags.fields);
    } catch {
      this.error('Invalid --fields JSON. Expected object like: \'{"key":"value"}\'');
    }

    const response = await client.mutateDataset(args.id, {
      operation: 'update',
      recordId: args['record-id'],
      fields,
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Record ${args['record-id']} updated`);
    }

    return response.data;
  }
}
