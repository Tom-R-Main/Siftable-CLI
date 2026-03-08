import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsSchema extends BaseCommand {
  static description = 'Modify dataset schema (add, update, or delete fields)';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    operation: Flags.string({
      description: 'Schema operation',
      options: ['add_field', 'update_field', 'delete_field'],
      required: true,
    }),
    'field-id': Flags.string({description: 'Field ID (required for update/delete)'}),
    field: Flags.string({
      description: 'Field definition as JSON, e.g. \'{"name":"email","type":"text"}\'',
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsSchema);
    const client = await this.client(flags);

    const operation = flags.operation as 'add_field' | 'update_field' | 'delete_field';

    if ((operation === 'update_field' || operation === 'delete_field') && !flags['field-id']) {
      this.error(`--field-id is required for ${operation}`);
    }

    if ((operation === 'add_field' || operation === 'update_field') && !flags.field) {
      this.error(`--field is required for ${operation}`);
    }

    let field: Record<string, unknown> | undefined;
    if (flags.field) {
      try {
        field = JSON.parse(flags.field);
      } catch {
        this.error('Invalid --field JSON.');
      }
    }

    const response = await client.modifyDatasetSchema(args.id, {
      operation,
      fieldId: flags['field-id'],
      field,
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Schema ${operation.replace('_', ' ')} completed on dataset ${args.id}`);
    }

    return response.data;
  }
}
