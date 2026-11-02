import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipGeneratedAssetsUsageList extends BaseCommand {
  static description = 'List append-only usage and outcome links for one generated asset';
  static args = {id: Args.string({description: 'Generated asset UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipGeneratedAssetsUsageList);
    const response = await this.apiRequest<{usage: Array<Record<string, unknown>>}>(
      flags,
      `/api/v1/relationship-playbooks/generated-assets/${encodeURIComponent(args.id)}/usage`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.usage.map((usage) => ({
        kind: usage.kind,
        outcome: usage.outcomeRef ?? '',
        actor: usage.actorUserId,
        at: usage.createdAt,
      })), [
        {key: 'kind', header: 'Use'},
        {key: 'outcome', header: 'Outcome'},
        {key: 'actor', header: 'Actor'},
        {key: 'at', header: 'Recorded'},
      ]);
    }
    return response.usage;
  }
}
