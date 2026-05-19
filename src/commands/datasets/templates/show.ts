import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';

export default class DatasetsTemplatesShow extends BaseCommand {
  static description = 'Show a built-in dataset template schema';

  static args = {
    template: Args.string({
      description: 'Template name',
      options: ['sources', 'people', 'events', 'claims'],
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsTemplatesShow);
    const client = await this.client(flags);
    const response = await client.showDatasetTemplate(args.template);
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const template = (result.template ?? {}) as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Template', template.name],
        ['Required provenance', template.requiredProvenance ? 'yes' : 'no'],
      ]);
      this.log('');
      renderTable((template.fields ?? []) as Record<string, unknown>[], [
        {key: 'name', header: 'Field'},
        {key: 'type', header: 'Type'},
        {key: 'required', header: 'Required', get: (row) => row.required ? 'yes' : 'no'},
      ]);
    }

    return result;
  }
}
