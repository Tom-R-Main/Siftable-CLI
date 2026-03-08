import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class DatasetsMaterialize extends BaseCommand {
  static description = 'Materialize a derived result into a new scratch dataset';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Title of the new dataset', required: true}),
    description: Flags.string({description: 'Dataset description'}),
    'source-result': Flags.string({description: 'Inline JSON for a derived result', required: false}),
    'source-result-file': Flags.string({description: 'Path to a JSON file containing a derived result', required: false}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsMaterialize);
    const client = await this.client(flags);

    const sourceResult = this.parseJsonInput<Record<string, unknown>>(
      flags['source-result'],
      flags['source-result-file'],
      '--source-result',
    );
    if (!sourceResult) {
      this.error('Provide --source-result or --source-result-file.');
    }

    const response = await client.materializeDatasetResult({
      sourceResult,
      title: flags.title,
      description: flags.description,
    });
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', data?.materializedDatasetId],
        ['Title', data?.title],
        ['Rows', data?.rowCount],
        ['Fields', data?.fieldCount],
      ]);
    }

    return response.data;
  }
}
