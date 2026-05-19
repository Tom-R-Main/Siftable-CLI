import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {splitCsvFlag} from '../../lib/entity-ref.js';
import {renderDetail} from '../../lib/output.js';

export default class TimelineNarrative extends BaseCommand {
  static description = 'Generate a narrative summary or explanation for timeline facts';

  static flags = {
    ...BaseCommand.baseFlags,
    action: Flags.string({
      description: 'Narrative action',
      options: ['summarize', 'changed_since', 'led_to', 'what_next', 'cross_object'],
      default: 'summarize',
    }),
    entity: Flags.string({description: 'Entity scope as type:uuid'}),
    participant: Flags.string({description: 'Participant filter as type:uuid'}),
    'related-entity': Flags.string({description: 'Related entity as type:uuid'}),
    'entity-roles': Flags.string({description: 'Comma-separated entity roles'}),
    'fact-type': Flags.string({description: 'Fact type filter'}),
    'source-type': Flags.string({description: 'Source type filter'}),
    q: Flags.string({description: 'Text query filter'}),
    prompt: Flags.string({description: 'Question or custom narrative prompt'}),
    limit: Flags.integer({description: 'Maximum timeline facts to include', default: 60}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TimelineNarrative);
    const client = await this.client(flags);
    const response = await client.createTimelineNarrative({
      action: flags.action,
      entity: flags.entity,
      participant: flags.participant,
      relatedEntity: flags['related-entity'],
      entityRoles: splitCsvFlag(flags['entity-roles']),
      factType: flags['fact-type'],
      sourceType: flags['source-type'],
      q: flags.q,
      prompt: flags.prompt,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Action', flags.action],
        ['Answer', result.answer],
      ]);
    }

    return result;
  }
}
