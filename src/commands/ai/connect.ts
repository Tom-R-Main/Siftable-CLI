import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class AiConnect extends BaseCommand {
  static description = 'Show the secure browser flow for adding a non-exportable Model Connection';
  static flags = {
    ...BaseCommand.baseFlags,
    url: Flags.string({
      description: 'Siftable Model Connections settings URL',
      default: 'https://siftable.io/settings/model-connections',
    }),
  };

  async run(): Promise<{url: string; credentialEntry: 'browser_only'}> {
    const {flags} = await this.parse(AiConnect);
    const result = {
      url: flags.url,
      credentialEntry: 'browser_only' as const,
    };
    if (!this.jsonEnabled()) {
      this.log('Add or replace provider credentials in the secure browser flow:');
      this.log(result.url);
      this.log('The CLI never receives or stores the provider API key.');
    }
    return result;
  }
}
