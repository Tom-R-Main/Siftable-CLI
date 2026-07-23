import {BaseCommand} from '../../lib/base-command.js';

export default class CapabilitiesList extends BaseCommand {
  static description = 'List safe metadata for Vault capability handles';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CapabilitiesList);
    const response = await this.apiRequest<{capabilities: Array<Record<string, unknown>>}>(
      flags,
      '/api/v1/vault/capabilities?surface=cli',
    );
    if (!this.jsonEnabled()) {
      if (response.capabilities.length === 0) {
        this.log('No Vault capabilities found.');
      }
      for (const capability of response.capabilities) {
        this.log(
          `${capability.id}  ${capability.adapterId}  `
          + `${(capability.allowedOperations as string[]).join(',')}  `
          + `${capability.revokedAt ? 'revoked' : 'active'}`,
        );
      }
    }
    return response.capabilities;
  }
}
