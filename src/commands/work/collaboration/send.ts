import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  collaborationActorFlag,
  collaborationActorOptions,
  collaborationData,
  normalizeCollaborationIdempotencyKey,
  renderCollaborationEventMutation,
} from '../../../lib/work-collaboration.js';

type EventKind = 'message' | 'artifact_published';
type EventPart =
  | {kind: 'text'; text: string}
  | {kind: 'artifact_reference'; artifactId: string; label: string | null}
  | {kind: 'work_item_reference'; workItemId: string; label: string | null};

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
    const response = await client.sendWorkItemCollaborationEvent(
      args.id,
      {
        kind: flags.kind as EventKind,
        parts,
        idempotencyKey,
        replyToEventId: flags['reply-to-event-id'],
        supersedesEventId: flags['supersedes-event-id'],
      },
      collaborationActorOptions(flags),
    );
    this.handleApiError(response);
    const result = collaborationData(response.data);
    if (!this.jsonEnabled()) this.log(renderCollaborationEventMutation(result));
    return result;
  }
}
