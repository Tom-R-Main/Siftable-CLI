import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {eventEntityRefs, timelineProvenance} from '../../lib/timeline-input.js';
import {renderDetail} from '../../lib/output.js';

export default class EventsCreate extends BaseCommand {
  static description = 'Create a research event timeline fact with participants';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Event title', required: true}),
    body: Flags.string({description: 'Event notes/body'}),
    timestamp: Flags.string({description: 'ISO timestamp'}),
    year: Flags.integer({description: 'Historical year CE'}),
    'year-end': Flags.integer({description: 'Historical end year CE'}),
    precision: Flags.string({
      description: 'Temporal precision',
      options: ['millisecond', 'minute', 'hour', 'day', 'month', 'year', 'decade', 'century', 'millennium', 'mega_year', 'era'],
      default: 'year',
    }),
    person: Flags.string({description: 'Person UUID participant; repeatable', multiple: true}),
    org: Flags.string({description: 'Organization UUID participant; repeatable', multiple: true}),
    entity: Flags.string({description: 'Participant/entity as type:uuid or type:uuid:role; repeatable', multiple: true}),
    source: Flags.string({description: 'Source entity as type:uuid or type:uuid:role; repeatable', multiple: true}),
    confidence: Flags.string({description: 'Confidence level', options: ['low', 'medium', 'high']}),
    'source-label': Flags.string({description: 'Source/provenance label'}),
    'source-url': Flags.string({description: 'Source/provenance URL'}),
    'source-note': Flags.string({description: 'Source/provenance note'}),
    visibility: Flags.string({description: 'Timeline visibility', options: ['org_public', 'private', 'restricted']}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EventsCreate);
    if (!flags.timestamp && flags.year === undefined) {
      this.error('Provide either --timestamp or --year.');
    }

    let entities;
    try {
      entities = eventEntityRefs(flags);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid entity reference.');
    }

    const payload = {
      factType: 'event',
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
      provenance: timelineProvenance(flags),
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
        ['Time', item.timeLabel],
        ['Participants', entities.length],
      ]);
    }

    return result;
  }
}
