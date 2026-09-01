import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  normalizeCollaborationConsumerKey,
  renderCollaborationEvents,
} from '../../../lib/work-collaboration.js';

export default class WorkCollaborationWait extends BaseCommand {
  static description = 'Wait for mailbox events at least once; never acknowledges them automatically';

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
    'after-sequence': Flags.integer({description: 'Override cursor resume and wait after this sequence', min: 0}),
    limit: Flags.integer({description: 'Maximum events to return', min: 1, max: 100}),
    'wait-ms': Flags.integer({description: 'Long-poll duration in milliseconds', min: 0, max: 30_000}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationWait);
    let consumerKey: string;
    try {
      consumerKey = normalizeCollaborationConsumerKey(flags['consumer-key']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const client = await this.client(flags);
    const response = await client.waitForWorkItemCollaborationEvents(
      args.id,
      {
        consumerKey,
        afterSequence: flags['after-sequence'],
        limit: flags.limit,
        waitMs: flags['wait-ms'],
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationEvents(result));
    return result;
  }
}
