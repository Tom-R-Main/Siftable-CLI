import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class PeopleKinship extends BaseCommand {
  static description = 'Explain kinship or relationship distance between two people';

  static args = {
    egoPersonId: Args.string({description: 'Ego/source person ID', required: true}),
    targetPersonId: Args.string({description: 'Target person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'max-depth': Flags.integer({description: 'Maximum relationship depth', default: 6}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleKinship);
    const client = await this.client(flags);
    const response = await client.getKinship(args.egoPersonId, args.targetPersonId, {
      maxDepth: flags['max-depth'],
    });
    this.handleApiError(response);
    const kinship = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Ego', args.egoPersonId],
        ['Target', args.targetPersonId],
        ['Primary', JSON.stringify(kinship.primary ?? null)],
      ]);
    }

    return kinship;
  }
}
