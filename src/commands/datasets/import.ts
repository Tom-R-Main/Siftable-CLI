import {Args, Flags} from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {parseDatasetRows, inferFieldType} from '../../lib/dataset-files.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';

const REQUIRED_TEMPLATE_FIELDS: Record<string, string[]> = {
  sources: ['source_id', 'title'],
  people: ['name'],
  events: ['title'],
  claims: ['claim'],
  evidence_sources: ['source_id', 'title'],
  evidence_source_fragments: ['fragment_id', 'source_ref'],
  evidence_claims: ['claim_id', 'claim_text'],
  evidence_people: ['name'],
  evidence_organizations: ['name'],
  evidence_places: ['name'],
  evidence_artifacts: ['title'],
  evidence_events: ['event_id', 'title'],
  evidence_relationships: ['relationship_id', 'subject_ref', 'object_ref'],
  evidence_contradictions: ['contradiction_id', 'summary'],
};

const TEMPLATE_OPTIONS = Object.keys(REQUIRED_TEMPLATE_FIELDS);

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

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
      options: TEMPLATE_OPTIONS,
    }),
    'upsert-by': Flags.string({description: 'Field name used to update matching rows instead of creating duplicates'}),
    'batch-size': Flags.integer({description: 'Records per backend batch', default: 100}),
    'dry-run': Flags.boolean({description: 'Validate and plan the import without writing'}),
    metadata: Flags.string({description: 'Dataset metadata as JSON object when creating a new dataset'}),
    lifecycle: Flags.string({description: 'Lifecycle kind for generated datasets, e.g. scratch, benchmark, research-run'}),
    tags: Flags.string({description: 'Comma-separated lifecycle tags'}),
    'run-id': Flags.string({description: 'Lifecycle run identifier'}),
    ttl: Flags.string({description: 'Lifecycle TTL duration, e.g. 12h, 7d, 30d'}),
    scratch: Flags.boolean({description: 'Shortcut for --lifecycle scratch --tags scratch'}),
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

    if (flags.template) {
      const requiredFields = REQUIRED_TEMPLATE_FIELDS[flags.template] ?? [];
      const missing = new Map<string, number[]>();

      parsed.rows.forEach((row, index) => {
        for (const field of requiredFields) {
          if (isEmpty(row.fields[field])) {
            const rows = missing.get(field) ?? [];
            rows.push(index + 1);
            missing.set(field, rows);
          }
        }
      });

      if (missing.size > 0) {
        const missingSummary = Array.from(missing.entries())
          .map(([field, rows]) => `${field} (row${rows.length === 1 ? '' : 's'} ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? ', ...' : ''})`)
          .join('; ');
        this.error(
          `Dataset import failed validation for template ${flags.template}: missing required field(s): ${missingSummary}. `
          + `Fix the input file, or create a schema-only dataset explicitly with \`sift datasets create\`.`,
        );
      }
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
      const metadata = this.parseJsonFlag<Record<string, unknown>>(flags.metadata, '--metadata') ?? {};
      const lifecycle = buildLifecycleMetadata({
        lifecycle: flags.scratch ? (flags.lifecycle ?? 'scratch') : flags.lifecycle,
        tags: flags.scratch ? mergeTags(flags.tags, 'scratch') : flags.tags,
        runId: flags['run-id'],
        ttl: flags.ttl,
      });
      if (lifecycle) {
        metadata.lifecycle = {
          ...(metadata.lifecycle && typeof metadata.lifecycle === 'object' ? metadata.lifecycle as Record<string, unknown> : {}),
          ...lifecycle,
        };
      }
      const fields = parsed.headers.map(name => ({
        name,
        fieldType: inferFieldType(parsed.rows.slice(0, 100).map(row => row.fields[name])),
      }));

      const createResp = await client.createDataset({title, description, fields, metadata});
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

function mergeTags(existing: string | undefined, tag: string): string {
  const tags = new Set((existing ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  tags.add(tag);
  return [...tags].join(',');
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!match) {
    throw new Error('TTL must be a duration like 12h, 7d, or 30d');
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit];
}

function buildLifecycleMetadata(input: {
  lifecycle?: string;
  tags?: string;
  runId?: string;
  ttl?: string;
}): Record<string, unknown> | undefined {
  if (!input.lifecycle && !input.tags && !input.runId && !input.ttl) return undefined;
  const lifecycle: Record<string, unknown> = {};
  if (input.lifecycle) lifecycle.kind = input.lifecycle;
  if (input.tags) lifecycle.tags = input.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  if (input.runId) lifecycle.runId = input.runId;
  if (input.ttl) {
    const ttlMs = parseDurationMs(input.ttl);
    lifecycle.ttlMs = ttlMs;
    lifecycle.expiresAt = new Date(Date.now() + ttlMs).toISOString();
  }
  return lifecycle;
}
