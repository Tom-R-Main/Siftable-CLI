import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';
import {resolveContextSelection, type WorkspaceSummary} from '../../lib/workspace-context.js';

export default class WorkspacesCurrent extends BaseCommand {
  static description = 'Show the current Personal or collaborative workspace selection';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkspacesCurrent);
    const selection = resolveContextSelection({workspaceFlag: flags.workspace});
    let workspace: WorkspaceSummary | null = null;
    if (selection.selectedWorkspaceId) {
      const response = await this.apiRequest<{workspaces: WorkspaceSummary[]}>(
        {token: flags.token, 'api-url': flags['api-url'], workspace: null},
        '/api/v1/workspaces',
      );
      workspace = response.workspaces.find((candidate) => candidate.id === selection.selectedWorkspaceId) ?? null;
      if (!workspace) {
        this.error(`Selected workspace ${selection.selectedWorkspaceId} is unavailable. Run \`sift workspaces list\` and then \`sift workspaces use <id>\`.`);
      }
    }
    const result = {
      owner: workspace
        ? {kind: 'workspace', workspaceId: workspace.id, label: workspace.name}
        : {kind: 'user', label: 'Personal'},
      selection,
      workspace,
    };
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Owner', workspace?.name ?? 'Personal'],
        ['Kind', workspace ? 'workspace' : 'user'],
        ['Workspace ID', workspace?.id ?? '—'],
        ['Selection source', selection.selectionSource],
      ]);
    }
    return result;
  }
}
