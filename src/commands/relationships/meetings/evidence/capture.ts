import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsEvidenceCapture extends BaseCommand {
  static description = 'Capture consent-gated transcript evidence or explicitly declared manual notes';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact meeting evidence input JSON'}),
    'input-file': Flags.string({description: 'Path to exact meeting evidence input JSON'}),
    'idempotency-key': Flags.string({description: 'Caller-owned stable key for exact retries', required: true}),
    yes: Flags.boolean({description: 'Confirm canonical evidence capture'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipMeetingsEvidenceCapture);
    const parsed = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    if (parsed.idempotencyKey !== undefined && parsed.idempotencyKey !== flags['idempotency-key']) {
      this.error('The idempotencyKey in the input must match --idempotency-key.');
    }
    const input = {...parsed, idempotencyKey: flags['idempotency-key']};
    const confirmed = await this.confirmAction(
      'Capture this meeting evidence in the canonical relationship timeline?',
      flags,
    );
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{
      evidence: Record<string, unknown>;
      capture?: Record<string, unknown>;
    }>(flags, `${RELATIONSHIP_MEETINGS_API}/evidence`, {
      method: 'POST',
      idempotencyKey: flags['idempotency-key'],
      body: input,
    });
    if (!this.jsonEnabled()) {
      const authorization = response.evidence.authorization as Record<string, unknown> | undefined;
      renderDetail([
        ['Evidence event', response.evidence.eventId],
        ['Capture mode', authorization?.captureMode],
        ['Segments', Array.isArray(response.evidence.segments) ? response.evidence.segments.length : 0],
      ]);
    }
    return response;
  }
}
