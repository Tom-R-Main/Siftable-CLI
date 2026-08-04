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
      'Vault plaintext output is retired for CLI and MCP clients. For a local task, run `sift vault search <query> --owner personal`, then `sift vault materialize run --help` to create the actual destination-bound approval request. Use the first-party Siftable web Vault when an interactive browser reveal is required. Do not use generic `sift approvals request` for Vault materialization.',
      {exit: 1},
    );
  }
}
