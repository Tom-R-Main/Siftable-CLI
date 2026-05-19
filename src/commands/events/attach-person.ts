import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class EventsAttachPerson extends BaseCommand {
  static description = 'Attach a person participant to an existing research event';

  static args = {
    event: Args.string({description: 'Existing temporal fact ID', required: true}),
    person: Args.string({description: 'Person UUID to attach', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    role: Flags.string({description: 'Participant role', default: 'subject'}),
    yes: Flags.boolean({description: 'Confirm participant attachment without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EventsAttachPerson);
    const confirmed = await this.confirmAction(
      `Attach person ${args.person} to event ${args.event}?`,
      flags,
    );
    if (!confirmed) {
      this.log('Attach cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.addTimelineFactEntities(args.event, [{
      entityType: 'person',
      entityId: args.person,
      role: flags.role,
    }], this.idempotencyKey());
    this.handleApiError(response);
    const result: Record<string, unknown> = {
      ok: true,
      eventId: args.event,
      personId: args.person,
      role: flags.role,
      ...(response.data as Record<string, unknown>),
    };
    if (!this.jsonEnabled()) {
      const item = (result.item ?? {}) as Record<string, unknown>;
      renderDetail([
        ['Event ID', args.event],
        ['Person ID', args.person],
        ['Role', flags.role],
        ['Participants', Array.isArray(item.entities) ? item.entities.length : undefined],
      ]);
    }

    return result;
  }
}
