import {Args, Flags} from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {parseDatasetRows, inferFieldType} from '../../lib/dataset-files.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';

export default class DatasetsImport extends BaseCommand {
  static description = 'Import CSV, JSON, or JSONL rows into a new or existing dataset';

  static args = {
    file: Args.string({description: 'Path to CSV, JSON, or JSONL file', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Dataset title (defaults to filename)'}),
    description: Flags.string({description: 'Dataset description'}),
    'dataset-id': Flags.string({description: 'Import into existing dataset instead of creating a new one'}),
    template: Flags.string({
      description: 'Built-in template name',
      options: ['sources', 'people', 'events', 'claims'],
    }),
    'upsert-by': Flags.string({description: 'Field name used to update matching rows instead of creating duplicates'}),
    'batch-size': Flags.integer({description: 'Records per backend batch', default: 100}),
    'dry-run': Flags.boolean({description: 'Validate and plan the import without writing'}),
    yes: Flags.boolean({description: 'Confirm mutating imports without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsImport);
    const client = await this.client(flags);

    if (!fs.existsSync(args.file)) {
      this.error(`File not found: ${args.file}`);
    }

    let parsed;
    try {
      parsed = parseDatasetRows(args.file);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Failed to parse import file.');
    }
    if (parsed.rows.length === 0) {
      this.error('Import file has no data rows.');
    }

    if (!this.jsonEnabled()) {
      this.log(`Parsed: ${parsed.rows.length} rows, ${parsed.headers.length} columns`);
    }

    if (flags['dry-run'] && !flags['dataset-id']) {
      const result = {
        ok: true,
        dryRun: true,
        datasetId: null,
        template: flags.template,
        upsertBy: flags['upsert-by'],
        summary: {
          create: parsed.rows.length,
          update: 0,
          skip: 0,
          invalid: 0,
          warning: 0,
        },
        warnings: [
          {
            type: 'dataset_not_created',
            severity: 'warning',
            message: 'Provide --dataset-id to validate/upsert against an existing dataset; dry-run does not create a new dataset.',
          },
        ],
        inferredFields: parsed.headers.map((name) => ({
          name,
          fieldType: inferFieldType(parsed.rows.slice(0, 100).map((row) => row.fields[name])),
        })),
      };
      this.renderImportResult(result);
      return result;
    }

    if (!flags['dry-run']) {
      const confirmed = await this.confirmAction(
        `Import ${parsed.rows.length} rows${flags['dataset-id'] ? ` into ${flags['dataset-id']}` : ' into a new dataset'}?`,
        flags,
      );
      if (!confirmed) {
        this.log('Import cancelled.');
        return {ok: false, cancelled: true};
      }
    }

    let datasetId = flags['dataset-id'];
    if (!datasetId) {
      const title = flags.title || path.basename(args.file, path.extname(args.file));
      const description = flags.description || `Imported from ${path.basename(args.file)}`;
      const fields = parsed.headers.map(name => ({
        name,
        fieldType: inferFieldType(parsed.rows.slice(0, 100).map(row => row.fields[name])),
      }));

      const createResp = await client.createDataset({title, description, fields});
      this.handleApiError(createResp);
      const dataset = this.unwrapOne(createResp, 'dataset');
      datasetId = dataset.id as string;
    }

    const payload = {
      rows: parsed.rows,
      template: flags.template,
      upsertBy: flags['upsert-by'],
      batchSize: flags['batch-size'],
    };
    const response = flags['dry-run']
      ? await client.planDatasetImport(datasetId, payload)
      : await client.applyDatasetImport(datasetId, payload);

    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    this.renderImportResult(result);
    return result;
  }

  private renderImportResult(result: Record<string, unknown>): void {
    if (this.jsonEnabled()) {
      return;
    }
    renderDatasetImportResult(result);
  }
}
