import {Args, Flags} from '@oclif/core';
import type {SiftClient} from '@siftable/mcp-server/dist/exfClient.js';
import {BaseCommand} from '../../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  normalizeCollaborationIdempotencyKey,
  renderCollaborationParticipantMutation,
} from '../../../../lib/work-collaboration.js';

type AddParticipantInput = Parameters<SiftClient['addWorkItemCollaborationParticipant']>[1];
type AssignableRole = AddParticipantInput['role'];

export default class WorkCollaborationParticipantAdd extends BaseCommand {
  static description = 'Add a contributor, reviewer, or observer to a work-item mailbox';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
    'participant-user-id': Flags.string({description: 'User UUID represented by the participant', required: true}),
    'agent-alias-id': Flags.string({description: 'Agent alias UUID represented by the participant'}),
    role: Flags.string({
      description: 'Participant role',
      options: ['contributor', 'reviewer', 'observer'],
      required: true,
    }),
    'idempotency-key': Flags.string({
      description: 'Caller-owned stable 8-128 character key for exact retries',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationParticipantAdd);
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeCollaborationIdempotencyKey(flags['idempotency-key']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const client = await this.client(flags);
    const response = await client.addWorkItemCollaborationParticipant(
      args.id,
      {
        participantUserId: flags['participant-user-id'],
        agentAliasId: flags['agent-alias-id'],
        role: flags.role as AssignableRole,
        idempotencyKey,
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationParticipantMutation(result, 'Added'));
    return result;
  }
}
