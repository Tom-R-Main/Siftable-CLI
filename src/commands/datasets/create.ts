import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsCreate extends BaseCommand {
  static description = 'Create a dataset';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Dataset title', required: true}),
    description: Flags.string({description: 'Dataset description'}),
    fields: Flags.string({
      description: 'Field definitions as JSON array, e.g. \'[{"name":"age","type":"number"}]\'',
    }),
    'note-id': Flags.string({description: 'Link to an existing note'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsCreate);
    const client = await this.client(flags);

    let fields: Array<Record<string, unknown>> | undefined;
    if (flags.fields) {
      try {
        fields = JSON.parse(flags.fields);
      } catch {
        this.error('Invalid --fields JSON. Expected array like: \'[{"name":"col","type":"text"}]\'');
      }
    }

    const response = await client.createDataset({
      title: flags.title,
      description: flags.description,
      fields,
      noteId: flags['note-id'],
    });
    this.handleApiError(response);

    const dataset = this.unwrapOne(response, 'dataset');

    if (!this.jsonEnabled()) {
      this.log(`Dataset created: ${dataset.id}`);
    }

    return response.data;
  }
}
