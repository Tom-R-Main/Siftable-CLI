import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class PeopleBulkDelete extends BaseCommand {
  static description = 'Preview or bulk-delete contacts';

  static flags = {
    ...BaseCommand.baseFlags,
    ids: Flags.string({description: 'Comma-separated person IDs'}),
    'starts-with': Flags.string({description: 'Name prefix filter'}),
    contains: Flags.string({description: 'Name substring filter'}),
    equals: Flags.string({description: 'Exact name filter'}),
    relationship: Flags.string({description: 'Filter by relationshipToUser'}),
    'has-no-email': Flags.boolean({description: 'Only contacts without an email'}),
    confirm: Flags.boolean({description: 'Execute deletion instead of preview'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(PeopleBulkDelete);
    const client = await this.client(flags);
    const personIds = flags.ids?.split(',').map((id) => id.trim()).filter(Boolean);
    const filter = {
      nameStartsWith: flags['starts-with'],
      nameContains: flags.contains,
      nameEquals: flags.equals,
      relationshipEquals: flags.relationship,
      hasNoEmail: flags['has-no-email'] || undefined,
    };

    const response = await client.bulkDeletePeople({
      personIds,
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
        this.log(`Preview: ${data.matchedCount} contact(s) matched.${data.truncated ? ` Showing first ${data.shownCount}.` : ''}`);
        renderTable((data.matched || []) as Record<string, unknown>[], [
          {key: 'id', header: 'ID'},
          {key: 'name', header: 'Name'},
          {key: 'email', header: 'Email'},
          {key: 'relationshipToUser', header: 'Relationship'},
        ]);
        if (data.truncated) this.log('Results truncated to 200 matches per call.');
        this.log('Re-run with --confirm to execute deletion.');
      } else {
        this.log(`Deleted ${data.deletedCount} contact(s).`);
      }
    }

    return data;
  }
}
