import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  normalizeCollaborationIdempotencyKey,
  renderCollaborationParticipantMutation,
} from '../../../../lib/work-collaboration.js';

export default class WorkCollaborationParticipantRemove extends BaseCommand {
  static description = 'Remove an assignable participant from a work-item mailbox';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
    participantId: Args.string({description: 'Collaboration participant UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
    'idempotency-key': Flags.string({
      description: 'Caller-owned stable 8-128 character key for exact retries',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationParticipantRemove);
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeCollaborationIdempotencyKey(flags['idempotency-key']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const client = await this.client(flags);
    const response = await client.removeWorkItemCollaborationParticipant(
      args.id,
      args.participantId,
      idempotencyKey,
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationParticipantMutation(result, 'Removed'));
    return result;
  }
}
