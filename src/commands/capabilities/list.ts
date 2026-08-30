import {BaseCommand} from '../../lib/base-command.js';
import {collectionNavigation} from '../../lib/collection-navigation.js';

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
    const result = {
      ok: true,
      capabilities: response.capabilities,
      ...collectionNavigation(response.capabilities.length, Math.max(response.capabilities.length, 1), {
        cursorSupported: false,
        total: response.capabilities.length,
      }),
    };
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
    return result;
  }
}
