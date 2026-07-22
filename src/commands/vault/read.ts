import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class VaultRead extends BaseCommand {
  static description = 'Retired: Vault plaintext reveal is unavailable from the CLI';

  static args = {
    id: Args.string({description: 'Vault entry ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<never> {
    await this.parse(VaultRead);
    this.error(
      'Vault plaintext output is retired for CLI and MCP clients. Reveal the entry in the first-party Siftable web Vault. Brokered capabilities and approved materialization will replace agent-facing decrypt workflows.',
      {exit: 1},
    );
  }
}
