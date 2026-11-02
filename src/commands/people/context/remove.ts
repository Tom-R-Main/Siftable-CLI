import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {confirm, renderDetail} from '../../../lib/output.js';

export default class PeopleContextRemove extends BaseCommand {
  static description = 'Remove an owner-relative relationship context';

  static args = {
    personId: Args.string({description: 'Person ID', required: true}),
    relationshipId: Args.string({description: 'Context relationship ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'dry-run': Flags.boolean({description: 'Show what would be removed without writing'}),
    yes: Flags.boolean({char: 'y', description: 'Remove without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleContextRemove);
    if (flags['dry-run']) {
      const response = await this.apiRequest<Record<string, unknown>>(
        flags,
        `/api/v1/people/${args.personId}/context-relationships/${args.relationshipId}?dryRun=true`,
        {method: 'DELETE'},
      );
      if (!this.jsonEnabled()) renderDetail([['Dry run', 'yes'], ['Relationship', args.relationshipId]]);
      return response;
    }
    if (!flags.yes && flags['no-input']) {
      this.error('Refusing to remove a relationship context without --yes when --no-input is set.');
    }
    if (!flags.yes && !await confirm(`Remove relationship context ${args.relationshipId}?`)) this.error('Aborted.');
    await this.apiRequest<void>(
      flags,
      `/api/v1/people/${args.personId}/context-relationships/${args.relationshipId}`,
      {method: 'DELETE'},
    );
    if (!this.jsonEnabled()) this.log('Relationship context removed.');
    return {ok: true, personId: args.personId, relationshipId: args.relationshipId};
  }
}
