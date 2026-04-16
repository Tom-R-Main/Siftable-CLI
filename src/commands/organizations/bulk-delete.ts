import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class OrganizationsBulkDelete extends BaseCommand {
  static description = 'Preview or bulk-delete organizations';

  static flags = {
    ...BaseCommand.baseFlags,
    ids: Flags.string({description: 'Comma-separated organization IDs'}),
    'starts-with': Flags.string({description: 'Name prefix filter'}),
    contains: Flags.string({description: 'Name substring filter'}),
    equals: Flags.string({description: 'Exact name filter'}),
    type: Flags.string({description: 'Filter by organization type'}),
    relationship: Flags.string({description: 'Filter by relationship status'}),
    confirm: Flags.boolean({description: 'Execute deletion instead of preview'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(OrganizationsBulkDelete);
    const client = await this.client(flags);
    const organizationIds = flags.ids?.split(',').map((id) => id.trim()).filter(Boolean);
    const filter = {
      nameStartsWith: flags['starts-with'],
      nameContains: flags.contains,
      nameEquals: flags.equals,
      type: flags.type,
      relationshipStatus: flags.relationship,
    };

    const response = await client.bulkDeleteOrganizations({
      organizationIds,
      filter,
      dryRun: !flags.confirm,
      confirm: flags.confirm,
    });
    this.handleApiError(response);
    const data = (response.data as {
      matched: Record<string, unknown>[];
      matchedCount: number;
      shownCount: number;
      deletedCount: number;
      previewOnly: boolean;
      truncated: boolean;
    } | undefined) || {matched: [], matchedCount: 0, shownCount: 0, deletedCount: 0, previewOnly: true, truncated: false};

    if (!this.jsonEnabled()) {
      if (data.previewOnly) {
        this.log(`Preview: ${data.matchedCount} organization(s) matched.${data.truncated ? ` Showing first ${data.shownCount}.` : ''}`);
        renderTable((data.matched || []) as Record<string, unknown>[], [
          {key: 'id', header: 'ID'},
          {key: 'name', header: 'Name'},
          {key: 'type', header: 'Type'},
          {key: 'relationshipStatus', header: 'Relationship'},
        ]);
        if (data.truncated) this.log('Results truncated to 200 matches per call.');
        this.log('Re-run with --confirm to execute deletion.');
      } else {
        this.log(`Deleted ${data.deletedCount} organization(s).`);
      }
    }

    return data;
  }
}
