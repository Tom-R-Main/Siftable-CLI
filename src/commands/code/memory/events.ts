import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class CodeMemoryEvents extends BaseCommand {
  static description = 'List append-only curation/lineage events for a code memory';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of events'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryEvents);
    const client = await this.client(flags);
    const response = await client.listCodeMemoryEvents(args.id, flags.limit);
    this.handleApiError(response);

    const events = response.data?.events ?? [];
    if (!this.jsonEnabled()) {
      renderTable(events, [
        {key: 'createdAt', header: 'When'},
        {key: 'eventType', header: 'Event'},
        {key: 'actorType', header: 'Actor'},
        {key: 'previousState', header: 'From'},
        {key: 'newState', header: 'To'},
        {key: 'reason', header: 'Reason'},
      ]);
    }

    return events;
  }
}
