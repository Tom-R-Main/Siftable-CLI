import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseEntityRef} from '../../../lib/entity-ref.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipsActionsRun extends BaseCommand {
  static description = 'Run any canonical relationship action with replay-safe caller identity';

  static args = {
    id: Args.string({description: 'Canonical action ID from relationships actions list', required: true}),
    entity: Args.string({description: 'Relationship entity as opportunity:<uuid> or prospect:<uuid>'}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    entity: Flags.string({description: 'Target as prospect:uuid or opportunity:uuid'}),
    input: Flags.string({description: 'Action input JSON object'}),
    'input-file': Flags.string({description: 'Path to an action input JSON file'}),
    'expected-version': Flags.integer({description: 'Current collaboration version', min: 0}),
    'idempotency-key': Flags.string({
      description: 'Stable 8-128 character key for exact retries',
      required: true,
    }),
    yes: Flags.boolean({description: 'Confirm action execution'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsActionsRun);
    const entityInput = args.entity ?? flags.entity;
    const parsedEntity = entityInput ? parseEntityRef(entityInput) : undefined;
    if (parsedEntity && !['prospect', 'opportunity'].includes(parsedEntity.entityType)) {
      this.error('Entity must be prospect:uuid or opportunity:uuid.');
    }

    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    ) ?? {};
    const collaborationActions = new Set([
      'relationship.next_action.set',
      'relationship.assignment.set',
      'relationship.comment.add',
      'relationship.watch.set',
      'relationship.outcome_handoff.create',
    ]);
    const collaborationAction = collaborationActions.has(args.id);
    const exactOnceCollaboration = collaborationAction && args.id !== 'relationship.next_action.set';
    if (exactOnceCollaboration) {
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

    if (collaborationAction && !parsedEntity) {
      this.error('Provide an entity argument or --entity for relationship collaboration actions.');
    }

    const confirmed = await this.confirmAction(`Run ${args.id}${entityInput ? ` for ${entityInput}` : ''}?`, flags);
    if (!confirmed) return {cancelled: true};

    let result: Record<string, unknown>;
    if (collaborationAction) {
      const response = await this.apiRequest<{result: Record<string, unknown>}>(
        flags,
        '/api/v1/ontology/relationship-actions/run',
        {
          method: 'POST',
          idempotencyKey: flags['idempotency-key'],
          body: {
            actionId: args.id,
            entity: {kind: parsedEntity!.entityType, id: parsedEntity!.entityId},
            input,
          },
        },
      );
      result = response.result;
    } else {
      const client = await this.client(flags);
      const response = await client.runRelationshipAction(args.id, {
        ...(parsedEntity ? {entity: {kind: parsedEntity.entityType, id: parsedEntity.entityId}} : {}),
        input,
      }, flags['idempotency-key']);
      this.handleApiError(response);
      result = (response.data ?? {}) as Record<string, unknown>;
    }
    if (!this.jsonEnabled()) {
      const execution = (result.execution ?? result) as Record<string, unknown>;
      const proposal = result.proposal as Record<string, unknown> | undefined;
      const outcome = result.outcome as Record<string, unknown> | undefined;
      const outcomeResult = outcome?.result as Record<string, unknown> | undefined;
      const outcomeDetail = outcomeResult?.detail as Record<string, unknown> | undefined;
      const rows: Array<[string, unknown]> = [
        ['Action', args.id],
        ['Entity', entityInput ?? '-'],
        ['Status', execution.status ?? outcome?.status ?? '-'],
      ];
      if (proposal?.id) rows.push(['Proposal', proposal.id]);
      const destination = proposal?.destination as Record<string, unknown> | undefined;
      if (destination?.senderAccountId) rows.push(['Sender account', destination.senderAccountId]);
      if (destination?.senderEmailAddress) rows.push(['From', destination.senderEmailAddress]);
      if (outcomeDetail?.approvalUrl) rows.push(['Approval', outcomeDetail.approvalUrl]);
      renderDetail(rows);
    }
    return result;
  }
}
