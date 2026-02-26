import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryStore extends BaseCommand {
  static description = 'Store a codebase fact';

  static flags = {
    ...BaseCommand.baseFlags,
    fact: Flags.string({description: 'Fact to store (1-2 sentences)', required: true}),
    category: Flags.string({
      description: 'Fact category',
      required: true,
      options: ['architecture', 'integration', 'convention', 'entrypoint', 'gotcha', 'ownership'],
    }),
    file: Flags.string({description: 'Related file path'}),
    repo: Flags.string({description: 'Repository ID'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodeMemoryStore);
    const client = await this.client(flags);
    const response = await client.storeCodeMemory({
      fact: flags.fact,
      category: flags.category as 'architecture' | 'integration' | 'convention' | 'entrypoint' | 'gotcha' | 'ownership',
      filePath: flags.file,
      repositoryId: flags.repo,
    });
    this.handleApiError(response);

    const memory = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      this.log(`Fact stored: ${memory.id}`);
    }

    return response.data;
  }
}
