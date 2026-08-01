import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipsHandoffsList extends BaseCommand {
  static description = 'List immutable relationship outcome receipts in the onboarding queue';
  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum receipts', min: 1, max: 200, default: 100}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipsHandoffsList);
    const response = await this.apiRequest<{handoffs: Array<Record<string, unknown>>}>(
      flags,
      `/api/v1/ontology/relationship-handoffs?limit=${flags.limit}`,
    );
    if (!this.jsonEnabled()) {
      for (const handoff of response.handoffs) {
        const entity = handoff.entity as Record<string, unknown>;
        this.log(`${handoff.id}  ${entity.kind}:${entity.id}  ${handoff.createdAt}`);
      }
    }
    return response.handoffs;
  }
}
