import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {describeSession, scopeFlags, setupScope, type SetupSession, setupWorkspace} from '../../lib/setupSession.js';

export default class SetupStatus extends BaseCommand {
  static description = 'Show a setup plan: its status, what is still needed, and the plan page';

  static examples = ['<%= config.bin %> setup status <setup-id>', '<%= config.bin %> setup status <setup-id> --json'];

  static args = {id: Args.string({description: 'Setup session ID', required: true})};

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SetupStatus);
    const scope = setupScope(flags.workspace, (flag) => this.workspaceId(flag));
    const workspace = setupWorkspace(scope);
    const body = await this.apiRequest<{session: SetupSession}>(scopeFlags(flags, scope),
      `/api/v1/setup/sessions/${encodeURIComponent(args.id)}?workspaceId=${encodeURIComponent(workspace)}`);
    if (!this.jsonEnabled()) for (const line of describeSession(body.session, flags['api-url'])) this.log(line);
    return body;
  }
}
