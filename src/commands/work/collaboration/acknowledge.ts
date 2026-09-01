import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  normalizeCollaborationConsumerKey,
  renderCollaborationCursor,
} from '../../../lib/work-collaboration.js';

export default class WorkCollaborationAcknowledge extends BaseCommand {
  static description = 'Advance a named mailbox cursor through one exact, durably processed sequence';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
    'consumer-key': Flags.string({
      description: 'Stable non-secret key naming this durable event consumer',
      required: true,
    }),
    'last-sequence': Flags.integer({
      description: 'Exact highest contiguous sequence durably processed by this consumer',
      required: true,
      min: 0,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationAcknowledge);
    let consumerKey: string;
    try {
      consumerKey = normalizeCollaborationConsumerKey(flags['consumer-key']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const client = await this.client(flags);
    const response = await client.acknowledgeWorkItemCollaborationCursor(
      args.id,
      {
        consumerKey,
        lastSequence: flags['last-sequence'],
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationCursor(result));
    return result;
  }
}
