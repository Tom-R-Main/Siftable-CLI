import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TimelineDelete extends BaseCommand {
  static description = 'Retract a timeline fact';

  static args = {
    id: Args.string({description: 'Timeline fact ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm retraction without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TimelineDelete);
    const confirmed = await this.confirmAction(`Retract timeline fact ${args.id}?`, flags);
    if (!confirmed) {
      this.log('Delete cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.deleteTimelineFact(args.id);
    this.handleApiError(response);
    const result = {ok: true, deleted: true, id: args.id};
    if (!this.jsonEnabled()) {
      this.log(`Retracted timeline fact ${args.id}.`);
    }
    return result;
  }
}
