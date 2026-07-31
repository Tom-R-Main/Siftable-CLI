import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class RelationshipsShow extends BaseCommand {
  static description = 'Show the current relationship collaboration snapshot';
  static args = {
    entity: Args.string({description: 'Relationship entity as opportunity:<uuid> or prospect:<uuid>', required: true}),
  };
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsShow);
    const match = /^(opportunity|prospect):([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(args.entity.trim());
    if (!match) this.error('Entity must be opportunity:<uuid> or prospect:<uuid>.');
    const response = await this.apiRequest<{snapshot: Record<string, unknown>}>(
      flags,
      `/api/v1/ontology/relationship-collaboration/${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
    );
    if (!this.jsonEnabled()) this.log(JSON.stringify(response.snapshot, null, 2));
    return response.snapshot;
  }
}
