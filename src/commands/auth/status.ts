import {BaseCommand} from '../../lib/base-command.js';
import {resolveToken} from '../../lib/auth.js';
import {getConfigDir} from '../../lib/config.js';

export default class AuthStatus extends BaseCommand {
  static description = 'Show authentication status';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<{authenticated: boolean; source?: string}> {
    const {flags} = await this.parse(AuthStatus);

    let source: string | undefined;
    const envToken = process.env.SIFT_TOKEN || process.env.EXF_TOKEN;
    if (flags.token || envToken) {
      source = flags.token ? 'flag' : (process.env.SIFT_TOKEN ? 'SIFT_TOKEN' : 'EXF_TOKEN');
    } else if (resolveToken()) {
      source = `config file (${getConfigDir()}/auth.json)`;
    }

    const authenticated = !!source;

    if (!this.jsonEnabled()) {
      if (authenticated) {
        this.log(`Authenticated via ${source}`);
      } else {
        this.log('Not authenticated. Run `sift auth login` or set SIFT_TOKEN.');
      }
    }

    return {authenticated, source};
  }
}
