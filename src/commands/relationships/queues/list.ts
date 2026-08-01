import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipsQueuesList extends BaseCommand {
  static description = 'List relationship team queues in the active workspace';
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipsQueuesList);
    const response = await this.apiRequest<{queues: Array<Record<string, unknown>>}>(
      flags,
      '/api/v1/ontology/relationship-queues',
    );
    if (!this.jsonEnabled()) {
      for (const queue of response.queues) this.log(`${queue.id}  ${queue.kind}  ${queue.name}`);
    }
    return response.queues;
  }
}
