import {Flags} from '@oclif/core';
import {isAbsolute} from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {readConfig} from '../../lib/config.js';
import {renderDetail} from '../../lib/output.js';
import {
  findCheckoutRoot,
  findRepositoryForCheckout,
  inferPrincipalDeclaration,
  resolveContextSelection,
  type RepositorySummary,
  type WorkspaceSummary,
} from '../../lib/workspace-context.js';

interface CurrentUser {
  id: string;
  email: string;
  name?: string | null;
}

export default class ContextCurrent extends BaseCommand {
  static description = 'Explain the current principal, owner, project, and local checkout context';

  static flags = {
    ...BaseCommand.baseFlags,
    'workspace-root': Flags.string({
      description: 'Absolute local checkout root to describe (never sent as a workspace tenant ID)',
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ContextCurrent);
    const checkoutRoot = flags['workspace-root'] ?? findCheckoutRoot();
    if (flags['workspace-root'] && !isAbsolute(flags['workspace-root'])) {
      this.error('--workspace-root must be an absolute local filesystem path.');
    }
    const selection = resolveContextSelection({
      workspaceFlag: flags.workspace,
      checkoutRoot,
    });
    const discoveryFlags = {token: flags.token, 'api-url': flags['api-url'], workspace: null};
    const [user, workspacesResponse] = await Promise.all([
      this.apiRequest<CurrentUser>(discoveryFlags, '/api/v1/user/me'),
      this.apiRequest<{workspaces: WorkspaceSummary[]}>(discoveryFlags, '/api/v1/workspaces'),
    ]);
    const workspace = selection.selectedWorkspaceId
      ? workspacesResponse.workspaces.find((candidate) => candidate.id === selection.selectedWorkspaceId) ?? null
      : null;
    if (selection.selectedWorkspaceId && !workspace) {
      this.error(`Selected workspace ${selection.selectedWorkspaceId} is unavailable. Run \`sift workspaces list\` and choose an exact ID.`);
    }

    const client = await this.client({
      token: flags.token,
      'api-url': flags['api-url'],
      workspace: selection.selectedWorkspaceId,
    });
    const repositoriesResponse = await client.listCodeRepositories();
    const repositories = repositoriesResponse.error
      ? []
      : this.unwrapList(repositoriesResponse, 'repositories') as RepositorySummary[];
    const repository = findRepositoryForCheckout(repositories, checkoutRoot);
    const configuredPrincipal = readConfig()?.principalType;
    const principal = inferPrincipalDeclaration({
      userId: user.id,
      selectedWorkspaceId: selection.selectedWorkspaceId,
      configuredType: configuredPrincipal,
    });
    const owner = workspace
      ? {kind: 'workspace', workspaceId: workspace.id, label: workspace.name}
      : {kind: 'user', userId: user.id, label: 'Personal'};
    const result = {
      contractVersion: 1,
      principal: {...principal, surface: 'cli'},
      owner,
      queryContext: {
        selectedWorkspaceContextId: workspace?.id ?? null,
        projectId: repository?.projectId ?? null,
      },
      project: repository?.projectId ? {id: repository.projectId, source: 'registered_repository'} : null,
      repository: repository ? {id: repository.id ?? null, name: repository.name ?? null} : null,
      checkout: {root: checkoutRoot, cwd: process.cwd()},
      sources: {
        principal: principal.authority,
        owner: selection.selectionSource,
        project: repositoriesResponse.error ? 'unavailable' : repository ? 'registered_repository_match' : 'none',
        checkout: flags['workspace-root'] ? 'workspace_root_flag' : checkoutRoot ? 'git' : 'none',
      },
    };
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Principal', `${principal.type} (${principal.authority})`],
        ['Owner', owner.label],
        ['Workspace', workspace?.id ?? '—'],
        ['Project', repository?.projectId ?? '—'],
        ['Repository', repository?.name ?? repository?.id ?? '—'],
        ['Checkout root', checkoutRoot ?? '—'],
        ['Working directory', process.cwd()],
      ]);
    }
    return result;
  }
}
