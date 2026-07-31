import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseEntityRef} from '../../../lib/entity-ref.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipActionsRun extends BaseCommand {
  static description = 'Run a canonical relationship action envelope';
  static args = {action: Args.string({description: 'Registered action ID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    entity: Flags.string({description: 'Target as prospect:uuid or opportunity:uuid', required: true}),
    input: Flags.string({description: 'Action input JSON object'}),
    'input-file': Flags.string({description: 'Path to action input JSON object'}),
    yes: Flags.boolean({description: 'Confirm action execution'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipActionsRun);
    const entity = parseEntityRef(flags.entity);
    if (!['prospect', 'opportunity'].includes(entity.entityType)) {
      this.error('Entity must be prospect:uuid or opportunity:uuid.');
    }
    const input = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (!input) this.error('Provide --input or --input-file.');
    const confirmed = await this.confirmAction(`Run ${args.action} for ${flags.entity}?`, flags);
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{result: Record<string, unknown>}>(
      flags,
      '/api/v1/ontology/relationship-actions/run',
      {
        method: 'POST',
        body: {
          actionId: args.action,
          entity: {kind: entity.entityType, id: entity.entityId},
          input,
        },
      },
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Action', args.action],
        ['Entity', flags.entity],
        ['Status', response.result.status],
      ]);
    }
    return response.result;
  }
}
