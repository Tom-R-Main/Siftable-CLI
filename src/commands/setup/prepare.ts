import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {describeSession, scopeFlags, setupScope, type SetupSession, setupWorkspace} from '../../lib/setupSession.js';

export default class SetupPrepare extends BaseCommand {
  static description = 'Prepare a first-run setup plan to fix a failing test; review and run it on the plan page';

  static examples = [
    '<%= config.bin %> setup prepare --input-file plan.json',
    '<%= config.bin %> setup prepare --input \'{"repository":{"url":"https://github.com/acme/parser"},"test":{"command":"npm test"}}\' --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'The plan as JSON (recipe defaults to fix_failing_test)'}),
    'input-file': Flags.string({description: 'Path to the plan as a JSON file'}),
    provenance: Flags.string({description: 'JSON map of plan field to {source, detail}, for values you did not choose yourself'}),
    'idempotency-key': Flags.string({description: 'Repeat a lost request with the key it was sent with'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(SetupPrepare);
    const scope = setupScope(flags.workspace, (flag) => this.workspaceId(flag));
    const input = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (!input) this.error('Provide the plan with --input or --input-file.');
    const provenance = this.parseJsonFlag<Record<string, unknown>>(flags.provenance, 'provenance');
    const body = await this.apiRequest<{session: SetupSession}>(scopeFlags(flags, scope), '/api/v1/setup/sessions', {
      method: 'POST',
      // With no --workspace and no saved selection, the server picks the user's only workspace.
      body: {...(flags.workspace === undefined && scope === null ? {} : {workspaceId: setupWorkspace(scope)}), surface: 'cli', input: {recipe: 'fix_failing_test', ...input},
        ...(provenance ? {provenance} : {})},
      idempotencyKey: flags['idempotency-key'] ?? this.idempotencyKey(),
    });
    if (!this.jsonEnabled()) for (const line of describeSession(body.session, flags['api-url'])) this.log(line);
    return body;
  }
}
