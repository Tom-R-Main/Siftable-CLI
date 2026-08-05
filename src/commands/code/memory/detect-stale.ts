import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryDetectStale extends BaseCommand {
  static description = 'Detect likely-stale code memories and mark them needs_review (never deletes)';

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository ID'}),
    limit: Flags.integer({description: 'Maximum memories to scan'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodeMemoryDetectStale);
    const client = await this.client(flags);
    const response = await client.detectStaleCodeMemories({
      repositoryId: flags.repo,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const memories = response.data?.memories ?? [];
    if (!this.jsonEnabled()) {
      this.log(`Marked ${memories.length} memories needs_review`);
      for (const memory of memories) {
        this.log(`- ${memory.id}: ${String(memory.content).slice(0, 80)}`);
      }
    }

    return response.data;
  }
}
