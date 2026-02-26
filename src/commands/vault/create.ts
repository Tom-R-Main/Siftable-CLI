import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class VaultCreate extends BaseCommand {
  static description = 'Store a new encrypted secret';

  static examples = [
    `<%= config.bin %> vault create --name "API Key" --payload '{"key":"sk-xxx"}'`,
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Secret name', required: true}),
    payload: Flags.string({description: 'JSON payload to encrypt', required: true}),
    type: Flags.string({
      description: 'Entry type',
      options: ['env_var', 'credential', 'oauth_token', 'ssh_key', 'certificate', 'note'],
    }),
    slug: Flags.string({description: 'Machine-friendly identifier'}),
    description: Flags.string({description: 'Description'}),
    tags: Flags.string({description: 'Comma-separated tags'}),
    category: Flags.string({description: 'Category'}),
    url: Flags.string({description: 'Associated URL'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultCreate);
    const client = await this.client(flags);

    let payload: Record<string, string>;
    try {
      payload = JSON.parse(flags.payload);
    } catch {
      this.error('Invalid JSON payload. Use --payload \'{"key":"value"}\'');
    }

    const response = await client.createVaultEntry({
      name: flags.name,
      payload,
      entryType: flags.type as 'env_var' | 'credential' | 'oauth_token' | 'ssh_key' | 'certificate' | 'note' | undefined,
      slug: flags.slug,
      description: flags.description,
      tags: flags.tags?.split(',').map(t => t.trim()),
      category: flags.category,
      url: flags.url,
    });
    this.handleApiError(response);

    const entry = this.unwrapOne(response, 'entry');

    if (!this.jsonEnabled()) {
      this.log(`Vault entry created: ${entry.id}`);
    }

    return response.data;
  }
}
