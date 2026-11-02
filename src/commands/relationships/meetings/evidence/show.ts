import {Args} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsEvidenceShow extends BaseCommand {
  static description = 'Inspect one canonical meeting-evidence event and its source locators';

  static args = {
    id: Args.string({description: 'Relationship meeting evidence event UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipMeetingsEvidenceShow);
    const response = await this.apiRequest<{evidence: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/evidence/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) {
      const authorization = response.evidence.authorization as Record<string, unknown> | undefined;
      renderDetail([
        ['Evidence event', response.evidence.eventId],
        ['Occurred', response.evidence.occurredAt],
        ['Capture mode', authorization?.captureMode],
        ['Segments', Array.isArray(response.evidence.segments) ? response.evidence.segments.length : 0],
      ]);
    }
    return response.evidence;
  }
}
