import {BaseCommand} from '../../lib/base-command.js';
import {clearToken} from '../../lib/auth.js';
import {getConfigDir} from '../../lib/config.js';

export default class AuthLogout extends BaseCommand {
  static description = 'Remove stored authentication';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<{cleared: boolean}> {
    await this.parse(AuthLogout);
    clearToken();
    if (!this.jsonEnabled()) {
      this.log(`Token removed from ${getConfigDir()}/auth.json`);
    }

    return {cleared: true};
  }
}
