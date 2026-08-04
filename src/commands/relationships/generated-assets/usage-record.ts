import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipGeneratedAssetsUsageRecord extends BaseCommand {
  static description = 'Append an export, internal-share, or outcome-link record to a generated asset';
  static args = {id: Args.string({description: 'Generated asset UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    kind: Flags.string({options: ['exported', 'shared_internally', 'outcome_linked'], required: true}),
    outcome: Flags.string({description: 'Stable outcome reference; required for outcome_linked'}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character retry key', required: true}),
    yes: Flags.boolean({description: 'Confirm append-only usage record'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipGeneratedAssetsUsageRecord);
    if (!await this.confirmAction(`Record ${flags.kind} usage for generated asset ${args.id}?`, flags)) {
      return {cancelled: true};
    }
    const body = {
      kind: flags.kind,
      outcomeRef: flags.outcome ?? null,
      idempotencyKey: flags['idempotency-key'],
    };
    const response = await this.apiRequest<{usage: Record<string, unknown>}>(
      flags,
      `/api/v1/relationship-playbooks/generated-assets/${encodeURIComponent(args.id)}/usage`,
      {method: 'POST', body, idempotencyKey: flags['idempotency-key']},
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Usage', response.usage.usageId],
      ['Kind', response.usage.kind],
      ['Outcome', response.usage.outcomeRef ?? '—'],
    ]);
    return response.usage;
  }
}
