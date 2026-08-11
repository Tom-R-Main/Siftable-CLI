import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerEvaluate extends BaseCommand {
  static description = 'Evaluate the current durable draft and append phrase-anchored coaching findings';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerEvaluate);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/coaching/evaluate`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'] } },
    );
    const findings = Array.isArray(response.session.findings) ? response.session.findings : [];
    const gate = response.session.reviewGate as Record<string, unknown>;
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Coaching', response.session.coachingState],
      ['Findings', findings.length],
      ['Review eligible', gate.eligible],
    ]);
    return response.session;
  }
}
