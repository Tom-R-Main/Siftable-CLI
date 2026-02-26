import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DocumentsUpload extends BaseCommand {
  static description = 'Upload a document (PDF, Markdown, or text) as a note';

  static args = {
    file: Args.string({description: 'Path to file', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Note title (defaults to filename)'}),
    type: Flags.string({
      description: 'Note type',
      options: ['note', 'concept', 'meeting', 'reference', 'daily', 'dataset'],
    }),
    project: Flags.string({description: 'Project ID'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DocumentsUpload);
    const client = await this.client(flags);
    const response = await client.uploadDocument({
      filePath: args.file,
      title: flags.title,
      noteType: flags.type,
      projectId: flags.project,
    });
    this.handleApiError(response);

    const doc = this.unwrapOne(response, 'note');

    if (!this.jsonEnabled()) {
      this.log(`Document uploaded: ${doc.id || doc.noteId || 'success'}`);
    }

    return response.data;
  }
}
