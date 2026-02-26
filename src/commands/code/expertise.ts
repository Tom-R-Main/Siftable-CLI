import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodeExpertise extends BaseCommand {
  static description = 'Refresh developer expertise index for a repository';

  static args = {
    repo: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeExpertise);
    const client = await this.client(flags);
    const response = await client.computeExpertise(args.repo);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log('Expertise index refreshed');
    }

    return response.data;
  }
}
