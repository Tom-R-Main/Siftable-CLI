import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

export default class PeopleContextAdd extends BaseCommand {
  static description = 'Add an owner-relative Personal or Work relationship';

  static args = {
    personId: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    context: Flags.string({description: 'Relationship context', options: ['personal', 'work'], required: true}),
    relationship: Flags.string({description: 'Relationship type, e.g. friend, client, mentor', required: true}),
    primary: Flags.boolean({description: 'Make this the primary relationship in its context', default: true}),
    basis: Flags.string({description: 'Why this relationship is recorded'}),
    confidence: Flags.string({description: 'Evidence confidence from 0 to 1'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleContextAdd);
    const confidence = flags.confidence === undefined ? undefined : Number(flags.confidence);
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      this.error('--confidence must be a number between 0 and 1');
    }
    const response = await this.apiRequest<{relationship: Record<string, unknown>}>(
      flags,
      `/api/v1/people/${args.personId}/context-relationships`,
      {
        method: 'POST',
        idempotencyKey: this.idempotencyKey(),
        body: {
          context: flags.context as 'personal' | 'work',
          relationshipType: flags.relationship,
          isPrimary: flags.primary,
          basis: flags.basis,
          confidence,
        },
      },
    );
    const relationship = response.relationship;
    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', relationship.id],
        ['Context', relationship.context],
        ['Relationship', relationship.relationshipType],
        ['Primary', relationship.isPrimary],
      ]);
    }
    return response;
  }
}
