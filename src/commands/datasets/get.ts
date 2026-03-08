import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class DatasetsGet extends BaseCommand {
  static description = 'Get dataset details and schema';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsGet);
    const client = await this.client(flags);
    const response = await client.summarizeDataset(args.id);
    this.handleApiError(response);

    const summary = this.unwrapOne(response, 'summary');

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', summary.datasetId],
        ['Title', summary.title],
        ['Rows', summary.rowCount],
        ['Fields', summary.fieldCount],
        ['Formula Fields', summary.formulaFieldCount],
        ['Object Bound', summary.objectBound],
      ]);
    }

    return response.data;
  }
}
