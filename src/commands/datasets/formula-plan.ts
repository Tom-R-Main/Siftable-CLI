import {Args, Flags} from '@oclif/core';
import {writeFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {DatasetDiffPlan} from '../../lib/dataset-diff-plan.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';
import {splitFields} from '../../lib/dataset-query.js';
import {renderDetail} from '../../lib/output.js';

function readRowValue(row: Record<string, unknown>, field: string): unknown {
  const fields = row.fields as Record<string, unknown> | undefined;
  const record = row.record as Record<string, unknown> | undefined;
  const recordFields = record?.fields as Record<string, unknown> | undefined;
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];
  if (fields && Object.prototype.hasOwnProperty.call(fields, field)) return fields[field];
  if (recordFields && Object.prototype.hasOwnProperty.call(recordFields, field)) return recordFields[field];
  return undefined;
}

export default class DatasetsFormulaPlan extends BaseCommand {
  static description = 'Compute formula fields and preview reviewable dataset updates';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'computed-fields': Flags.string({
      description: 'JSON array of computed fields, e.g. \'[{"as":"score","expression":"confidence * reliability"}]\'',
      required: true,
    }),
    'upsert-by': Flags.string({description: 'Field used to match rows for update', required: true}),
    'target-fields': Flags.string({description: 'Comma-separated computed field names to write; defaults to every computed field alias'}),
    filters: Flags.string({description: 'JSON array of filters for compute source'}),
    select: Flags.string({description: 'Comma-separated fields to include in compute source'}),
    'order-by': Flags.string({description: 'JSON array of order clauses'}),
    sorts: Flags.string({description: 'JSON array of output sorts'}),
    limit: Flags.integer({description: 'Maximum rows to compute and plan', default: 100}),
    template: Flags.string({
      description: 'Built-in template name for validation',
      options: ['sources', 'people', 'events', 'claims'],
    }),
    'save-plan': Flags.string({description: 'Write an applyable diff plan JSON file'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsFormulaPlan);
    const client = await this.client(flags);
    const computedFields = this.parseJsonFlag<Array<{as: string; expression: string; description?: string}>>(
      flags['computed-fields'],
      '--computed-fields',
    ) ?? [];
    const targetFields = splitFields(flags['target-fields']) ?? computedFields.map((field) => field.as);
    if (targetFields.length === 0) {
      this.error('At least one target field is required.');
    }

    const select = Array.from(new Set([
      flags['upsert-by'],
      ...(splitFields(flags.select) ?? []),
    ]));

    const computeResponse = await client.computeDatasetFields(args.id, {
      filters: this.parseJsonFlag(flags.filters, '--filters') as Array<Record<string, unknown>> | undefined,
      select,
      computedFields,
      orderBy: this.parseJsonFlag(flags['order-by'], '--order-by') as Array<Record<string, unknown>> | undefined,
      sorts: this.parseJsonFlag(flags.sorts, '--sorts') as Array<Record<string, unknown>> | undefined,
      limit: flags.limit,
    });
    this.handleApiError(computeResponse);
    const computeResult = computeResponse.data as Record<string, unknown>;
    const computedRows = ((computeResult.rows ?? []) as Record<string, unknown>[]);
    const proposedRows = computedRows.map((row) => {
      const fields: Record<string, unknown> = {
        [flags['upsert-by']]: readRowValue(row, flags['upsert-by']),
      };
      for (const field of targetFields) {
        fields[field] = readRowValue(row, field);
      }
      return {fields};
    });

    const planResponse = await client.planDatasetImport(args.id, {
      rows: proposedRows,
      template: flags.template,
      upsertBy: flags['upsert-by'],
      batchSize: flags.limit,
    });
    this.handleApiError(planResponse);
    const planResult = planResponse.data as Record<string, unknown>;

    let planPath: string | undefined;
    if (flags['save-plan']) {
      const plan: DatasetDiffPlan = {
        kind: 'sift.datasetDiffPlan',
        version: 1,
        datasetId: args.id,
        template: flags.template,
        upsertBy: flags['upsert-by'],
        batchSize: flags.limit,
        rows: proposedRows,
        dryRunResult: planResult,
      };
      writeFileSync(flags['save-plan'], `${JSON.stringify(plan, null, 2)}\n`);
      planPath = flags['save-plan'];
    }

    const result = {
      ok: true,
      dryRun: true,
      datasetId: args.id,
      computedFields,
      targetFields,
      computedRowCount: computedRows.length,
      proposedRows,
      planPath,
      compute: computeResult,
      importPlan: planResult,
      next: planPath
        ? [`Review ${planPath}`, `Run \`sift datasets apply-diff ${planPath} --yes --json\` to apply reviewed formula results.`]
        : ['Run again with --save-plan <path> to create an applyable formula diff plan.'],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', args.id],
        ['Computed rows', computedRows.length],
        ['Proposed rows', proposedRows.length],
        ['Saved plan', planPath],
      ]);
      this.log('');
      renderDatasetImportResult(planResult);
    }

    return result;
  }
}
