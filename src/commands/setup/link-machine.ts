import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {describeSession, type SetupSession, setupWorkspace} from '../../lib/setupSession.js';

export default class SetupLinkMachine extends BaseCommand {
  static description = 'Name an enrolled machine as the setup plan\'s runner, with your own credential (not the machine\'s)';

  static examples = ['<%= config.bin %> setup link-machine <setup-id> --runner <runner-id>'];

  static args = {id: Args.string({description: 'Setup session ID', required: true})};

  static flags = {
    ...BaseCommand.baseFlags,
    runner: Flags.string({description: 'Runner ID that `sift machine enroll` printed', required: true}),
    yes: Flags.boolean({default: false, description: 'Replace a different runner the plan already names without asking'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SetupLinkMachine);
    const workspace = setupWorkspace(this.workspaceId(flags.workspace));
    const route = `/api/v1/setup/sessions/${encodeURIComponent(args.id)}`;
    const {session} = await this.apiRequest<{session: SetupSession}>(flags, `${route}?workspaceId=${encodeURIComponent(workspace)}`);
    const current = (session.plan.input.machine as {runnerId?: string} | undefined)?.runnerId;
    if (current === flags.runner) {
      if (!this.jsonEnabled()) this.log(`The plan already runs on ${flags.runner}.`);
      return {session};
    }
    if (current && !await this.confirmAction(`The plan runs on ${current}. Replace it with ${flags.runner}?`, flags)) {
      this.error('Not changed.');
    }
    const body = await this.apiRequest<{session: SetupSession}>(flags, `${route}/revisions`, {
      method: 'POST',
      body: {workspaceId: workspace, surface: 'cli', expectedVersion: session.currentVersion, changes: {'machine.runnerId': flags.runner},
        provenance: {'machine.runnerId': {source: 'machine', detail: 'enrolled with sift machine enroll'}}},
      idempotencyKey: this.idempotencyKey(),
    });
    if (!this.jsonEnabled()) for (const line of describeSession(body.session, flags['api-url'])) this.log(line);
    return body;
  }
}
