import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  renderCollaborationEvents,
} from '../../../lib/work-collaboration.js';

export default class WorkCollaborationEvents extends BaseCommand {
  static description = 'List ordered mailbox events without advancing any durable cursor';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
    'after-sequence': Flags.integer({description: 'Return events after this exact sequence', min: 0}),
    limit: Flags.integer({description: 'Maximum events to return', min: 1, max: 100}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationEvents);
    const client = await this.client(flags);
    const response = await client.listWorkItemCollaborationEvents(
      args.id,
      {
        afterSequence: flags['after-sequence'],
        limit: flags.limit,
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationEvents(result));
    return result;
  }
}
