import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class DatasetsSummarize extends BaseCommand {
  static description = 'Get a summary of a dataset (row count, fields, sample rows)';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsSummarize);
    const client = await this.client(flags);
    const response = await client.summarizeDataset(args.id);
    this.handleApiError(response);

    const summary = this.unwrapOne(response, 'summary');

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', summary.datasetId],
        ['Title', summary.title],
        ['Rows', summary.rowCount],
        ['Fields', summary.fieldCount],
        ['Formula Fields', summary.formulaFieldCount],
        ['Object Bound', summary.objectBound],
      ]);

      const sampleRows = (summary.sampleRows ?? []) as Array<Record<string, unknown>>;
      if (sampleRows.length > 0) {
        this.log('\nSample rows:');
        for (const row of sampleRows.slice(0, 3)) {
          const fields = row.fields as Record<string, unknown> | undefined;
          if (fields) {
            const preview = Object.entries(fields)
              .slice(0, 5)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            this.log(`  ${preview}${Object.keys(fields).length > 5 ? ', …' : ''}`);
          }
        }
      }
    }

    return response.data;
  }
}
