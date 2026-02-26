import {BaseCommand} from '../../lib/base-command.js';
import {resolveToken} from '../../lib/auth.js';

export default class AuthStatus extends BaseCommand {
  static description = 'Show authentication status';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<{authenticated: boolean; source?: string}> {
    const {flags} = await this.parse(AuthStatus);

    let source: string | undefined;
    if (flags.token) {
      source = flags.token.startsWith('exf_pat_') ? 'flag/env' : 'flag/env';
    } else if (resolveToken()) {
      source = 'config file (~/.config/exf/auth.json)';
    }

    const authenticated = !!source;

    if (!this.jsonEnabled()) {
      if (authenticated) {
        this.log(`Authenticated via ${source}`);
      } else {
        this.log('Not authenticated. Run `exf auth login` or set EXF_TOKEN.');
      }
    }

    return {authenticated, source};
  }
}
