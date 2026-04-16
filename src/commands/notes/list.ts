import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class NotesList extends BaseCommand {
  static description = 'List notes';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Filter by project ID'}),
    type: Flags.string({
      description: 'Filter by note type',
      options: ['note', 'concept', 'meeting', 'reference', 'daily', 'dataset'],
    }),
    limit: Flags.integer({description: 'Maximum number of results'}),
    'title-starts-with': Flags.string({description: 'Title prefix filter'}),
    'title-contains': Flags.string({description: 'Title substring filter'}),
    'title-equals': Flags.string({description: 'Exact title filter'}),
    archived: Flags.boolean({description: 'Filter by archived state'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(NotesList);
    const client = await this.client(flags);
    const response = await client.listNotes({
      projectId: flags.project,
      noteType: flags.type,
      limit: flags.limit,
      titleStartsWith: flags['title-starts-with'],
      titleContains: flags['title-contains'],
      titleEquals: flags['title-equals'],
      isArchived: flags.archived,
    });
    this.handleApiError(response);

    const notes = this.unwrapList(response, 'notes');

    if (!this.jsonEnabled()) {
      renderTable(notes, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'noteType', header: 'Type'},
        {key: 'updatedAt', header: 'Updated', get: (r) => r.updatedAt ? new Date(r.updatedAt as string).toLocaleDateString() : '—'},
      ]);
    }

    return notes;
  }
}
