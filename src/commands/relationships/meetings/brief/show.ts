import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsBriefShow extends BaseCommand {
  static description = 'Read the current cited meeting brief by recomposing its exact inputs';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact owner, subject, approved asset, and optional meeting JSON'}),
    'input-file': Flags.string({description: 'Path to exact meeting brief input JSON'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipMeetingsBriefShow);
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
      renderDetail([
        ['Brief', response.brief.briefId],
        ['Subject', JSON.stringify(response.brief.subject ?? {})],
        ['Generated', response.brief.generatedAt],
        ['Citations', Array.isArray(response.brief.citations) ? response.brief.citations.length : 0],
      ]);
    }
    return response.brief;
  }
}
