import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodebaseRegister extends BaseCommand {
  static description = 'Register a codebase for indexing';

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Repository name', required: true}),
    path: Flags.string({description: 'Absolute path to repository root', required: true}),
    project: Flags.string({description: 'Project ID to associate'}),
    'auto-index': Flags.boolean({description: 'Enable automatic indexing'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodebaseRegister);
    const client = await this.client(flags);
    const response = await client.createCodeRepository({
      name: flags.name,
      rootPath: flags.path,
      projectId: flags.project,
    });
    this.handleApiError(response);

    const repo = this.unwrapOne(response, 'repository');

    if (!this.jsonEnabled()) {
      this.log(`Repository registered: ${repo.id}`);
    }

    return response.data;
  }
}
