import {Args, Flags} from '@oclif/core';
import {existsSync, writeFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {parseDatasetRows} from '../../lib/dataset-files.js';
import {DatasetDiffPlan} from '../../lib/dataset-diff-plan.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';
import {renderDetail} from '../../lib/output.js';

export default class DatasetsDiff extends BaseCommand {
  static description = 'Preview dataset row changes from a CSV, JSON, or JSONL file';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'from-file': Flags.string({description: 'Path to CSV, JSON, or JSONL rows to compare', required: true}),
    template: Flags.string({
      description: 'Built-in template name',
      options: ['sources', 'people', 'events', 'claims'],
    }),
    'upsert-by': Flags.string({description: 'Field name used to match existing rows'}),
    'batch-size': Flags.integer({description: 'Records per backend batch', default: 100}),
    'save-plan': Flags.string({description: 'Write an applyable diff plan JSON file'}),
    persist: Flags.boolean({description: 'Persist the diff plan in Siftable for later review/apply'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsDiff);
    if (!existsSync(flags['from-file'])) {
      this.error(`File not found: ${flags['from-file']}`);
    }

    let parsed;
    try {
      parsed = parseDatasetRows(flags['from-file']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Failed to parse diff file.');
    }
    if (parsed.rows.length === 0) {
      this.error('Diff file has no data rows.');
    }

    const client = await this.client(flags);
    const response = flags.persist
      ? await client.createDatasetDiffPlan(args.id, {
        rows: parsed.rows,
        template: flags.template,
        upsertBy: flags['upsert-by'],
        batchSize: flags['batch-size'],
        source: { file: flags['from-file'] },
        generatedBy: 'import',
      })
      : await client.planDatasetImport(args.id, {
        rows: parsed.rows,
        template: flags.template,
        upsertBy: flags['upsert-by'],
        batchSize: flags['batch-size'],
      });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const dryRunResult = (result.dryRunResult && typeof result.dryRunResult === 'object')
      ? result.dryRunResult as Record<string, unknown>
      : result;

    let planPath: string | undefined;
    if (flags['save-plan']) {
      const plan: DatasetDiffPlan = {
        kind: 'sift.datasetDiffPlan',
        version: 1,
        datasetId: args.id,
        template: flags.template,
        upsertBy: flags['upsert-by'],
        batchSize: flags['batch-size'],
        sourceFile: flags['from-file'],
        rows: parsed.rows,
      dryRunResult,
      };
      writeFileSync(flags['save-plan'], `${JSON.stringify(plan, null, 2)}\n`);
      planPath = flags['save-plan'];
    }

    const output = {
      ok: true,
      ...dryRunResult,
      persistedPlan: result.plan,
      planPath,
      next: result.plan
        ? [`Review persisted plan ${((result.plan as Record<string, unknown>).id)}`, `Run \`sift datasets apply-diff ${((result.plan as Record<string, unknown>).id)} --yes --json\` to apply it.`]
        : planPath
        ? [`Review ${planPath}`, `Run \`sift datasets apply-diff ${planPath} --yes --json\` to apply the reviewed rows.`]
        : ['Run again with --save-plan <path> to create an applyable plan.'],
    };

    if (!this.jsonEnabled()) {
      renderDatasetImportResult(output);
      if (planPath) {
        this.log('');
        renderDetail([['Saved plan', planPath]]);
      }
    }

    return output;
  }
}
