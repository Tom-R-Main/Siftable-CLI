import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsCreate extends BaseCommand {
  static description = 'Create a dataset';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Dataset title', required: true}),
    description: Flags.string({description: 'Dataset description'}),
    fields: Flags.string({
      description: 'Field definitions as JSON array, e.g. \'[{"name":"age","type":"number"}]\'',
    }),
    metadata: Flags.string({description: 'Dataset metadata as JSON object'}),
    lifecycle: Flags.string({description: 'Lifecycle kind for generated datasets, e.g. scratch, benchmark, research-run'}),
    tags: Flags.string({description: 'Comma-separated lifecycle tags'}),
    'run-id': Flags.string({description: 'Lifecycle run identifier'}),
    ttl: Flags.string({description: 'Lifecycle TTL duration, e.g. 12h, 7d, 30d'}),
    scratch: Flags.boolean({description: 'Shortcut for --lifecycle scratch --tags scratch'}),
    'note-id': Flags.string({description: 'Link to an existing note'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsCreate);
    const client = await this.client(flags);

    let fields: Array<Record<string, unknown>> | undefined;
    if (flags.fields) {
      try {
        fields = JSON.parse(flags.fields);
      } catch {
        this.error('Invalid --fields JSON. Expected array like: \'[{"name":"col","type":"text"}]\'');
      }
    }

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

    const response = await client.createDataset({
      title: flags.title,
      description: flags.description,
      fields,
      noteId: flags['note-id'],
      metadata,
    });
    this.handleApiError(response);

    const dataset = this.unwrapOne(response, 'dataset');

    if (!this.jsonEnabled()) {
      this.log(`Dataset created: ${dataset.id}`);
    }

    return response.data;
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
