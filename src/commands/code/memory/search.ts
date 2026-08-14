import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class CodeMemorySearch extends BaseCommand {
  static description = 'Search stored curated code facts (excludes rejected/superseded by default)';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    category: Flags.string({
      description: 'Filter by category',
      options: ['architecture', 'integration', 'convention', 'entrypoint', 'gotcha', 'ownership'],
    }),
    repo: Flags.string({description: 'Repository ID'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
    'include-inactive': Flags.boolean({
      description: 'Include rejected and superseded lineage memories',
      default: false,
    }),
    lifecycle: Flags.string({
      description: 'Filter by lifecycle state',
      options: ['unreviewed', 'confirmed', 'rejected', 'superseded', 'needs_review'],
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemorySearch);
    const client = await this.client(flags);
    const response = await client.searchCodeMemories({
      query: args.query,
      category: flags.category as 'architecture' | 'integration' | 'convention' | 'entrypoint' | 'gotcha' | 'ownership' | undefined,
      repositoryId: flags.repo,
      limit: flags.limit,
      includeInactive: flags['include-inactive'],
      lifecycleState: flags.lifecycle,
    });
    this.handleApiError(response);

    const memories = this.unwrapList(response, 'memories');

    if (!this.jsonEnabled()) {
      renderTable(memories, [
        {key: 'id', header: 'ID'},
        {key: 'content', header: 'Fact'},
        {key: 'factType', header: 'Category'},
        {
          key: 'lifecycle',
          header: 'Lifecycle',
          get: row => {
            const lifecycle = row.lifecycle as Record<string, unknown> | undefined;
            return typeof lifecycle?.state === 'string' ? lifecycle.state : 'unknown';
          },
        },
        {key: 'confidence', header: 'Confidence'},
        {key: 'repositoryName', header: 'Repository'},
        {key: 'filePath', header: 'File'},
        {
          key: 'evidence',
          header: 'Evidence',
          get: row => {
            const evidence = row.evidence as Record<string, unknown> | undefined;
            return typeof evidence?.availability === 'string' ? evidence.availability : 'not_recorded';
          },
        },
      ]);
    }

    return memories;
  }
}
