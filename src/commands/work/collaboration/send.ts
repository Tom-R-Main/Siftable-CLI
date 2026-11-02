import {Args, Flags} from '@oclif/core';
import type {SiftClient} from '@siftable/mcp-server/dist/exfClient.js';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  collaborationParticipantLabels,
  normalizeCollaborationIdempotencyKey,
  renderCollaborationEventMutation,
  resolveCollaborationRecipients,
  type CollaborationParticipantLabels,
} from '../../../lib/work-collaboration.js';

type SendEventInput = Parameters<SiftClient['sendWorkItemCollaborationEvent']>[1];
type EventKind = SendEventInput['kind'];
type EventPart = SendEventInput['parts'][number];

export default class WorkCollaborationSend extends BaseCommand {
  static description = 'Append a retry-safe message or artifact event to a work-item mailbox';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'as-agent-id': collaborationActorFlag,
    kind: Flags.string({
      description: 'Client event kind',
      options: ['message', 'artifact_published'],
      default: 'message',
    }),
    text: Flags.string({description: 'Convenience text part; cannot be combined with --parts'}),
    parts: Flags.string({description: 'Exact collaboration event parts as a JSON array'}),
    'reply-to-event-id': Flags.string({description: 'Existing event UUID this event replies to'}),
    'supersedes-event-id': Flags.string({description: 'Caller-authored event UUID this event supersedes'}),
    'idempotency-key': Flags.string({
      description: 'Caller-owned stable 8-128 character key for exact retries',
      required: true,
    }),
    to: Flags.string({
      description: 'Address an active participant by participant UUID, actor UUID, or exact label (any case). Omit to address the whole room; addressing grants no authority',
      multiple: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCollaborationSend);
    if (flags.text !== undefined && flags.parts !== undefined) {
      this.error('Provide either --text or --parts, not both.');
    }
    const parts = flags.text !== undefined
      ? [{kind: 'text', text: flags.text} satisfies EventPart]
      : this.parseJsonFlag<EventPart[]>(flags.parts, 'parts');
    if (!Array.isArray(parts) || parts.length === 0) {
      this.error('Provide a non-empty --text or --parts JSON array.');
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeCollaborationIdempotencyKey(flags['idempotency-key']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const client = await this.client(flags);
    let recipientParticipantIds: string[] = [];
    let labels: CollaborationParticipantLabels | undefined;
    if (flags.to?.length) {
      const participantsResponse = await client.listWorkItemCollaborationParticipants(
        args.id,
        collaborationActorOptions(flags),
      );
      this.handleApiError(participantsResponse);
      const participants = collaborationData(participantsResponse.data);
      try {
        recipientParticipantIds = resolveCollaborationRecipients(participants, flags.to);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      labels = collaborationParticipantLabels(participants);
    }
    const response = await client.sendWorkItemCollaborationEvent(
      args.id,
      {
        kind: flags.kind as EventKind,
        parts,
        idempotencyKey,
        replyToEventId: flags['reply-to-event-id'],
        supersedesEventId: flags['supersedes-event-id'],
        // Sent only when non-empty so a server without addressing still accepts the body.
        ...(recipientParticipantIds.length > 0 ? {recipientParticipantIds} : {}),
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationEventMutation(result, labels));
    return result;
  }
}
