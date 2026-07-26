import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodebaseDelete extends BaseCommand {
  static description = 'Create a dry-run retirement plan for hosted indexed source';

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip plan confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseDelete);

    const confirmed = await this.confirmAction(
      'Create a retirement plan? This command does not delete indexed data.',
      flags,
    );
    if (!confirmed) {
      this.log('Cancelled.');
      return {planned: false};
    }

    const response = await this.apiRequest<{
      retirementPlan: {
        id: string;
        repositoryGeneration: string;
        planFingerprint: string;
        status: string;
        inventory: Record<string, unknown>;
        applyAvailablePublicly: false;
      };
    }>(flags, `/api/v1/code/repositories/${args.id}`, {method: 'DELETE'});
    const plan = response.retirementPlan;
    if (!plan) this.error('Server did not return a retirement plan.');

    if (!this.jsonEnabled()) {
      this.log(`Retirement plan ${plan.id} created for repository ${args.id}.`);
      this.log('No indexed data was deleted. Applying a purge requires a separately approved internal operation.');
    }

    return {
      planned: true,
      id: args.id,
      retirementPlan: plan,
    };
  }
}
