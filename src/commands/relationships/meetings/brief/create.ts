import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsBriefCreate extends BaseCommand {
  static description = 'Compose a cited meeting brief from approved relationship evidence';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact meeting brief input JSON'}),
    'input-file': Flags.string({description: 'Path to exact meeting brief input JSON'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipMeetingsBriefCreate);
    const input = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    const response = await this.apiRequest<{brief: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/briefs`,
      {method: 'POST', body: input},
    );
    if (!this.jsonEnabled()) {
      const meeting = response.brief.meeting as Record<string, unknown> | undefined;
      renderDetail([
        ['Brief', response.brief.briefId],
        ['Subject', JSON.stringify(response.brief.subject ?? {})],
        ['Meeting', meeting?.title ?? meeting?.relationshipEventId ?? 'No linked meeting'],
        ['Generated', response.brief.generatedAt],
      ]);
    }
    return response.brief;
  }
}
