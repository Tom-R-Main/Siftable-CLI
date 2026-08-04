import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {
  clearSavedWorkspaceSelection,
  writeSavedWorkspaceSelection,
  type WorkspaceSummary,
} from '../../lib/workspace-context.js';

export default class WorkspacesUse extends BaseCommand {
  static description = 'Select a collaborative workspace for discovery, or Personal to clear it';

  static args = {
    id: Args.string({description: 'Workspace ID, or "personal"', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkspacesUse);
    if (args.id.toLowerCase() === 'personal') {
      clearSavedWorkspaceSelection();
      const result = {owner: {kind: 'user', label: 'Personal'}, persisted: true};
      if (!this.jsonEnabled()) this.log('Current owner: Personal');
      return result;
    }
    const response = await this.apiRequest<{workspaces: WorkspaceSummary[]}>(
      {token: flags.token, 'api-url': flags['api-url'], workspace: null},
      '/api/v1/workspaces',
    );
    const workspace = response.workspaces.find((candidate) => candidate.id === args.id);
    if (!workspace) {
      this.error(`Workspace ${args.id} is unavailable. Run \`sift workspaces list\` and copy an exact ID.`);
    }
    writeSavedWorkspaceSelection({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      selectedAt: new Date().toISOString(),
    });
    const result = {
      owner: {kind: 'workspace', workspaceId: workspace.id, label: workspace.name},
      persisted: true,
      note: 'Workspace selected. Subsequent scoped commands send this exact tenant ID; use `sift workspaces use personal` to return to Personal.',
    };
    if (!this.jsonEnabled()) {
      this.log(`Current workspace: ${workspace.name} (${workspace.id})`);
      this.log(result.note);
    }
    return result;
  }
}
