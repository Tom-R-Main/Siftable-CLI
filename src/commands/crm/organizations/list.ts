import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

interface OrganizationSummary extends Record<string, unknown> {
  id: string;
  name: string;
  isWorkspace?: boolean;
}

export default class CrmOrganizationsList extends BaseCommand {
  static description = 'List CRM organizations only; collaborative workspaces are excluded';

  static flags = {
    ...BaseCommand.baseFlags,
    search: Flags.string({description: 'Optional fuzzy search query'}),
    limit: Flags.integer({description: 'Maximum number of CRM results', default: 100, min: 1, max: 200}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CrmOrganizationsList);
    const params = new URLSearchParams({limit: String(flags.limit)});
    if (flags.search) params.set('search', flags.search);
    const response = await this.apiRequest<{organizations: OrganizationSummary[]}>(
      {token: flags.token, 'api-url': flags['api-url']},
      `/api/v1/organizations?${params.toString()}`,
    );
    const organizations = response.organizations.filter((organization) => organization.isWorkspace !== true);
    const result = {
      organizations,
      excludedWorkspaceCount: response.organizations.length - organizations.length,
      kind: 'crm_organization',
    };
    if (!this.jsonEnabled()) {
      renderTable(organizations, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Organization'},
        {key: 'domain', header: 'Domain'},
        {key: 'relationshipStatus', header: 'Status'},
      ]);
    }
    return result;
  }
}
