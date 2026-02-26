import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class CodebaseStatus extends BaseCommand {
  static description = 'Check indexing status for a repository';

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseStatus);
    const client = await this.client(flags);
    const response = await client.getCodeRepository(args.id);
    this.handleApiError(response);

    const repo = this.unwrapOne(response, 'repository');

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', repo.id],
        ['Name', repo.name],
        ['Path', repo.rootPath],
        ['Status', repo.status],
        ['Files Indexed', repo.filesIndexed],
        ['Last Indexed', repo.lastIndexedAt],
      ]);
    }

    return response.data;
  }
}
