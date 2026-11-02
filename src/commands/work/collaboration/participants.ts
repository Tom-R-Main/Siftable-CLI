import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  renderCollaborationParticipants,
} from '../../../lib/work-collaboration.js';

export default class WorkCollaborationParticipants extends BaseCommand {
  static description = 'List the durable collaboration participants for a work item';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationParticipants);
    const client = await this.client(flags);
    const response = await client.listWorkItemCollaborationParticipants(
      args.id,
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationParticipants(result));
    return result;
  }
}
