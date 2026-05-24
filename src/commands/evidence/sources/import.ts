import {Args, Flags} from '@oclif/core';
import {existsSync} from 'node:fs';
import {BaseCommand} from '../../../lib/base-command.js';
import {inferFieldType, parseDatasetRows} from '../../../lib/dataset-files.js';
import {renderDatasetImportResult} from '../../../lib/dataset-import-render.js';

const REQUIRED_SOURCE_FIELDS = ['source_id', 'title'];

export default class EvidenceSourcesImport extends BaseCommand {
  static description = 'Import Evidence Graph source ledger rows into a dataset-backed source table';

  static args = {
    file: Args.string({description: 'Path to CSV, JSON, or JSONL source ledger rows', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'dataset-id': Flags.string({description: 'Evidence sources dataset ID'}),
    'upsert-by': Flags.string({description: 'Field name used to update matching source rows', default: 'source_id'}),
    'batch-size': Flags.integer({description: 'Records per backend batch', default: 100}),
    'dry-run': Flags.boolean({description: 'Validate and plan source import without writing'}),
    yes: Flags.boolean({description: 'Confirm mutating imports without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceSourcesImport);
    if (!existsSync(args.file)) {
      this.error(`File not found: ${args.file}`);
    }

    const parsed = parseDatasetRows(args.file);
    if (parsed.rows.length === 0) {
      this.error('Source import file has no data rows.');
    }

    const missing = requiredFieldErrors(parsed.rows);
    if (missing.length > 0) {
      this.error(`Evidence source import failed validation: missing required field(s): ${missing.join('; ')}.`);
    }

    const datasetId = flags['dataset-id'];
    if (flags['dry-run'] && !datasetId) {
      const result = {
        ok: true,
        dryRun: true,
        datasetId: null,
        template: 'evidence_sources',
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
            type: 'dataset_not_selected',
            severity: 'warning',
            message: 'Provide --dataset-id to validate/upsert against an existing Evidence sources dataset; offline dry-run did not call the API.',
          },
        ],
        inferredFields: parsed.headers.map((name) => ({
          name,
          fieldType: inferFieldType(parsed.rows.slice(0, 100).map((row) => row.fields[name])),
        })),
        evidence: {
          template: 'evidence_sources',
          policy: 'source-ledger-import',
          durableAssertionsApplied: false,
          apiCalled: false,
        },
        next: [
          'Run `sift evidence init <name> --yes --json` to create an Evidence sources dataset, or rerun this command with `--dataset-id <id>`.',
          `Then run \`sift evidence extract --source-dataset <id> --no-apply --json\`.`,
        ],
      };

      if (!this.jsonEnabled()) {
        renderDatasetImportResult(result);
      }
      return result;
    }

    if (!flags['dry-run'] && !datasetId) {
      this.error('Provide --dataset-id for mutating Evidence source imports.');
    }

    if (!flags['dry-run']) {
      const confirmed = await this.confirmAction(
        `Import ${parsed.rows.length} source rows into ${datasetId}?`,
        flags,
      );
      if (!confirmed) {
        this.log('Evidence source import cancelled.');
        return {ok: false, cancelled: true};
      }
    }

    const client = await this.client(flags);
    const payload = {
      rows: parsed.rows,
      upsertBy: flags['upsert-by'],
      batchSize: flags['batch-size'],
    };
    const targetDatasetId = datasetId!;
    const response = flags['dry-run']
      ? await client.planDatasetImport(targetDatasetId, payload)
      : await client.applyDatasetImport(targetDatasetId, payload);
    this.handleApiError(response);
    const result = {
      ...(response.data as Record<string, unknown>),
      evidence: {
        template: 'evidence_sources',
        policy: 'source-ledger-import',
        durableAssertionsApplied: false,
      },
      next: flags['dry-run']
        ? [`Review source ledger diff, then run \`sift evidence sources import ${args.file} --dataset-id ${targetDatasetId} --yes --json\`.`]
        : [`Run \`sift evidence extract --source-dataset ${targetDatasetId} --no-apply --json\`.`],
    };

    if (!this.jsonEnabled()) {
      renderDatasetImportResult(result);
    }
    return result;
  }
}

function requiredFieldErrors(rows: Array<{fields: Record<string, unknown>}>): string[] {
  const missing = new Map<string, number[]>();
  rows.forEach((row, index) => {
    for (const field of REQUIRED_SOURCE_FIELDS) {
      const value = row.fields[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        const rowNumbers = missing.get(field) ?? [];
        rowNumbers.push(index + 1);
        missing.set(field, rowNumbers);
      }
    }
  });
  return Array.from(missing.entries()).map(([field, rowNumbers]) => (
    `${field} (row${rowNumbers.length === 1 ? '' : 's'} ${rowNumbers.slice(0, 5).join(', ')}${rowNumbers.length > 5 ? ', ...' : ''})`
  ));
}
