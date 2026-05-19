import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseEntityRef} from '../../lib/entity-ref.js';
import {renderDetail} from '../../lib/output.js';

export default class TimelineCreate extends BaseCommand {
  static description = 'Create a user-authored timeline fact';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Fact title', required: true}),
    'fact-type': Flags.string({description: 'Fact type', default: 'event'}),
    body: Flags.string({description: 'Fact body or notes'}),
    timestamp: Flags.string({description: 'ISO timestamp'}),
    year: Flags.integer({description: 'Historical year CE'}),
    'year-end': Flags.integer({description: 'Historical end year CE'}),
    precision: Flags.string({
      description: 'Temporal precision',
      options: ['millisecond', 'minute', 'hour', 'day', 'month', 'year', 'decade', 'century', 'millennium', 'mega_year', 'era'],
      default: 'year',
    }),
    entity: Flags.string({
      description: 'Participant/entity as type:uuid or type:uuid:role; repeatable',
      multiple: true,
    }),
    confidence: Flags.string({
      description: 'Confidence level',
      options: ['low', 'medium', 'high'],
    }),
    'source-label': Flags.string({description: 'Source/provenance label'}),
    'source-url': Flags.string({description: 'Source/provenance URL'}),
    'source-note': Flags.string({description: 'Source/provenance note'}),
    visibility: Flags.string({
      description: 'Timeline visibility',
      options: ['org_public', 'private', 'restricted'],
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TimelineCreate);
    if (!flags.timestamp && flags.year === undefined) {
      this.error('Provide either --timestamp or --year.');
    }

    let entities;
    try {
      entities = (flags.entity ?? []).map((value: string) => parseEntityRef(value));
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid entity reference.');
    }

    const payload = {
      factType: flags['fact-type'],
      title: flags.title,
      body: flags.body,
      time: {
        timestamp: flags.timestamp,
        yearCE: flags.year,
        yearEndCE: flags['year-end'],
        precision: flags.precision,
      },
      entities,
      confidence: flags.confidence,
      provenance: {
        label: flags['source-label'],
        url: flags['source-url'],
        note: flags['source-note'],
      },
      visibility: flags.visibility,
    };

    const client = await this.client(flags);
    const response = await client.createTimelineFact(payload, this.idempotencyKey());
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const item = (result.item ?? result) as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', item.id],
        ['Title', item.title],
        ['Type', item.factType],
        ['Time', item.timeLabel],
      ]);
    }

    return result;
  }
}
