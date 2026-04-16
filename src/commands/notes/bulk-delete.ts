import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class NotesBulkDelete extends BaseCommand {
  static description = 'Preview or bulk-delete notes';

  static flags = {
    ...BaseCommand.baseFlags,
    ids: Flags.string({description: 'Comma-separated note IDs'}),
    'title-starts-with': Flags.string({description: 'Title prefix filter'}),
    'title-contains': Flags.string({description: 'Title substring filter'}),
    'title-equals': Flags.string({description: 'Exact title filter'}),
    type: Flags.string({options: ['note', 'concept', 'meeting', 'reference', 'daily', 'dataset']}),
    archived: Flags.boolean({description: 'Filter by archived state'}),
    confirm: Flags.boolean({description: 'Execute deletion instead of preview'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(NotesBulkDelete);
    const client = await this.client(flags);
    const noteIds = flags.ids?.split(',').map((id) => id.trim()).filter(Boolean);
    const filter = {
      titleStartsWith: flags['title-starts-with'],
      titleContains: flags['title-contains'],
      titleEquals: flags['title-equals'],
      noteType: flags.type,
      isArchived: flags.archived,
    };

    const response = await client.bulkDeleteNotes({
      noteIds,
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
        this.log(`Preview: ${data.matchedCount} note(s) matched.${data.truncated ? ` Showing first ${data.shownCount}.` : ''}`);
        renderTable((data.matched || []) as Record<string, unknown>[], [
          {key: 'id', header: 'ID'},
          {key: 'title', header: 'Title'},
          {key: 'noteType', header: 'Type'},
          {key: 'isArchived', header: 'Archived'},
        ]);
        if (data.truncated) this.log('Results truncated to 200 matches per call.');
        this.log('Re-run with --confirm to execute deletion.');
      } else {
        this.log(`Deleted ${data.deletedCount} note(s).`);
      }
    }

    return data;
  }
}
