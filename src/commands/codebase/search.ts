import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

interface RetiredSourceSearchError extends Error {
  api: {
    type: 'removed_capability';
    capability: 'codebase_search';
    recovery: string;
  };
  code: 'removed_capability';
  oclif: {exit: 2};
  suggestions: string[];
}

const RECOVERY = 'Use local `rg` or `git grep` in an authorized checkout. Siftable source upload, indexing, and search are retired; `sift code memory search` searches curated facts, not repository files.';

export default class CodebaseSearch extends BaseCommand {
  static description = 'Explain the retired source-code search command and its local recovery';

  static args = {
    query: Args.string({description: 'Legacy source-code search query', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<never> {
    await this.parse(CodebaseSearch);
    const error = new Error(`Source-code search is no longer available through Siftable. ${RECOVERY}`) as RetiredSourceSearchError;
    error.code = 'removed_capability';
    error.oclif = {exit: 2};
    error.api = {
      type: 'removed_capability',
      capability: 'codebase_search',
      recovery: RECOVERY,
    };
    error.suggestions = [
      'Run `rg <query>` or `git grep <query>` from the authorized checkout.',
      'Run `sift code memory search <query>` only when you want curated code facts.',
    ];
    throw error;
  }
}
