import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class NotesCreate extends BaseCommand {
  static description = 'Create a note';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Note title', required: true}),
    content: Flags.string({description: 'Note content (markdown)'}),
    type: Flags.string({
      description: 'Note type',
      options: ['note', 'concept', 'meeting', 'reference', 'daily', 'dataset'],
    }),
    project: Flags.string({description: 'Project ID'}),
    metadata: Flags.string({description: 'Note metadata as JSON'}),
    'metadata-file': Flags.string({description: 'Read note metadata JSON from a file'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(NotesCreate);
    const client = await this.client(flags);
    const metadata = this.parseJsonInput<Record<string, unknown>>(
      flags.metadata,
      flags['metadata-file'],
      'metadata',
    );
    if (metadata !== undefined && (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object')) {
      this.error('Metadata must be a JSON object.');
    }
    const response = await client.createNote(
      {
        title: flags.title,
        content: flags.content,
        noteType: flags.type,
        projectId: flags.project,
        metadata,
      },
      this.idempotencyKey(),
    );
    this.handleApiError(response);

    const note = this.unwrapOne(response, 'note');

    if (!this.jsonEnabled()) {
      this.log(`Note created: ${note.id}`);
    }

    return response.data;
  }
}
