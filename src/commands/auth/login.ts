import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {storeToken} from '../../lib/auth.js';

export default class AuthLogin extends BaseCommand {
  static description = 'Authenticate with ExecuFunction';

  static examples = [
    '<%= config.bin %> auth login --token exf_pat_xxx',
    'EXF_TOKEN=exf_pat_xxx <%= config.bin %> auth status',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    token: Flags.string({
      description: 'Personal access token',
      env: 'EXF_TOKEN',
    }),
  };

  async run(): Promise<{stored: boolean}> {
    const {flags} = await this.parse(AuthLogin);
    const token = flags.token;

    if (!token) {
      this.error('Provide a token with --token or EXF_TOKEN environment variable.');
    }

    storeToken(token);
    if (!this.jsonEnabled()) {
      this.log('Token stored in ~/.config/exf/auth.json');
    }

    return {stored: true};
  }
}
