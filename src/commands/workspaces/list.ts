import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {resolveContextSelection, type WorkspaceSummary} from '../../lib/workspace-context.js';

export default class WorkspacesList extends BaseCommand {
  static description = 'List collaborative workspaces available to the authenticated user';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkspacesList);
    const response = await this.apiRequest<{workspaces: WorkspaceSummary[]}>(
      {token: flags.token, 'api-url': flags['api-url']},
      '/api/v1/workspaces',
    );
    const selectedId = resolveContextSelection({workspaceFlag: flags.workspace}).selectedWorkspaceId;
    const workspaces = response.workspaces.map((workspace) => ({
      ...workspace,
      selected: workspace.id === selectedId,
    }));
    if (!this.jsonEnabled()) {
      renderTable(workspaces as unknown as Record<string, unknown>[], [
        {key: 'selected', header: 'Current', get: (row) => row.selected ? '*' : ''},
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Workspace'},
        {key: 'role', header: 'Role'},
        {key: 'memberCount', header: 'Members'},
      ]);
    }
    return {workspaces, selectedWorkspaceId: selectedId};
  }
}
