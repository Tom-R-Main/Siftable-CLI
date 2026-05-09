import {Args, Flags} from '@oclif/core';
import path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

type RepositorySummary = {
  id?: string;
  rootPath?: string;
  projectId?: string;
};

function isInsidePath(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findRepositoryForCwd(repositories: RepositorySummary[], cwd = process.cwd()): RepositorySummary | undefined {
  return repositories
    .filter((repo) => repo.id && repo.rootPath && !repo.rootPath.startsWith('git://') && isInsidePath(cwd, repo.rootPath))
    .sort((left, right) => path.resolve(right.rootPath!).length - path.resolve(left.rootPath!).length)[0];
}

export default class CodebaseSearch extends BaseCommand {
  static description = 'Semantic code search';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository ID'}),
    project: Flags.string({description: 'Project ID'}),
    language: Flags.string({description: 'Filter by language'}),
    'symbol-type': Flags.string({
      description: 'Filter by symbol type',
      options: ['function', 'class', 'interface', 'type', 'export', 'impl'],
    }),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseSearch);
    if (flags.repo && flags.project) {
      this.error('Provide either --repo or --project, not both.');
    }

    const client = await this.client(flags);
    let repositoryId = flags.repo;
    let projectId = flags.project;

    if (!repositoryId && !projectId) {
      const repositoriesResponse = await client.listCodeRepositories();
      this.handleApiError(repositoriesResponse);
      const currentRepo = findRepositoryForCwd(this.unwrapList(repositoriesResponse, 'repositories') as RepositorySummary[]);
      repositoryId = currentRepo?.id;
      projectId = currentRepo?.projectId;
    }

    const response = await client.searchCode({
      query: args.query,
      repositoryId,
      projectId,
      language: flags.language,
      symbolType: flags['symbol-type'],
      limit: flags.limit,
    });
    this.handleApiError(response);

    const results = this.unwrapList(response, 'results');

    if (!this.jsonEnabled()) {
      if (results.length) {
        renderTable(results, [
          {key: 'filePath', header: 'File'},
          {key: 'symbolName', header: 'Symbol'},
          {key: 'symbolType', header: 'Type'},
          {key: 'similarity', header: 'Score', get: (r) => r.similarity != null ? String(Number(r.similarity).toFixed(2)) : '—'},
        ]);
      } else {
        this.log('No results found.');
      }
    }

    return results;
  }
}
