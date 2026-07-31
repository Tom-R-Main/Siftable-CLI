import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseEntityRef} from '../../../lib/entity-ref.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipsActionsRun extends BaseCommand {
  static description = 'Run any canonical relationship action with replay-safe caller identity';

  static args = {
    action: Args.string({description: 'Canonical action ID from relationships actions list', required: true}),
    entity: Args.string({description: 'Relationship entity as opportunity:<uuid> or prospect:<uuid>'}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    entity: Flags.string({description: 'Target as prospect:uuid or opportunity:uuid'}),
    input: Flags.string({description: 'Action input JSON object'}),
    'input-file': Flags.string({description: 'Path to an action input JSON file'}),
    'expected-version': Flags.integer({description: 'Current collaboration version', min: 0}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for exact retries'}),
    yes: Flags.boolean({description: 'Confirm action execution'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsActionsRun);
    const entityInput = args.entity ?? flags.entity;
    if (!entityInput) this.error('Provide an entity argument or --entity.');
    const parsedEntity = parseEntityRef(entityInput);
    if (!['prospect', 'opportunity'].includes(parsedEntity.entityType)) {
      this.error('Entity must be prospect:uuid or opportunity:uuid.');
    }

    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    ) ?? {};
    const exactOnce = args.action !== 'relationship.next_action.set';
    if (exactOnce) {
      if (flags['expected-version'] === undefined) {
        this.error('--expected-version is required for relationship collaboration actions.');
      }
      if (!flags['idempotency-key']
        || !/^[A-Za-z0-9_.:-]{8,128}$/.test(flags['idempotency-key'])) {
        this.error('--idempotency-key must contain 8-128 letters, numbers, dots, colons, underscores, or hyphens.');
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== flags['expected-version']) {
        this.error('The expectedVersion in --input must match --expected-version.');
      }
      input.expectedVersion = flags['expected-version'];
    } else if (flags['expected-version'] !== undefined) {
      this.error('--expected-version is not accepted by relationship.next_action.set.');
    }

    const confirmed = await this.confirmAction(`Run ${args.action} for ${entityInput}?`, flags);
    if (!confirmed) return {cancelled: true};

    const response = await this.apiRequest<{result: Record<string, unknown>}>(
      flags,
      '/api/v1/ontology/relationship-actions/run',
      {
        method: 'POST',
        idempotencyKey: flags['idempotency-key'],
        body: {
          actionId: args.action,
          entity: {kind: parsedEntity.entityType, id: parsedEntity.entityId},
          input,
        },
      },
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Action', args.action],
        ['Entity', entityInput],
        ['Status', response.result.status],
      ]);
    }
    return response.result;
  }
}
