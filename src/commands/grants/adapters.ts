import {BaseCommand} from '../../lib/base-command.js';

export default class GrantsAdapters extends BaseCommand {
  static description = 'List reviewed local execution adapters and honest containment tiers';
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(GrantsAdapters);
    const response = await this.apiRequest<{adapters: Array<Record<string, unknown>>}>(
      flags,
      '/api/v1/vault/execution-grants/adapters',
    );
    if (!this.jsonEnabled()) {
      for (const adapter of response.adapters) {
        this.log(`${adapter.id}  ${adapter.tier}  ${(adapter.operations as string[]).join(',') || 'none'}`);
        this.log(`  ${adapter.threatDisclosure}`);
      }
    }
    return response.adapters;
  }
}
