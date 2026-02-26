import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class VaultUpdate extends BaseCommand {
  static description = 'Update vault entry metadata';

  static args = {
    id: Args.string({description: 'Vault entry ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Entry name'}),
    description: Flags.string({description: 'Description'}),
    tags: Flags.string({description: 'Comma-separated tags'}),
    category: Flags.string({description: 'Category'}),
    url: Flags.string({description: 'Associated URL'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.name !== undefined) updates.name = flags.name;
    if (flags.description !== undefined) updates.description = flags.description;
    if (flags.tags !== undefined) updates.tags = flags.tags.split(',').map(t => t.trim());
    if (flags.category !== undefined) updates.category = flags.category;
    if (flags.url !== undefined) updates.url = flags.url;

    const response = await client.updateVaultEntry(args.id, updates);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Vault entry ${args.id} updated`);
    }

    return response.data;
  }
}
