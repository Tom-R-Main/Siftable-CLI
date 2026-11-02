import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {describeSession, parseSetPairs, scopeFlags, setupScope, type SetupSession, setupWorkspace} from '../../lib/setupSession.js';

export default class SetupContinue extends BaseCommand {
  static description = 'Change values in a setup plan; each change makes a new version and clears any approval';

  static examples = [
    '<%= config.bin %> setup continue <setup-id> --version 2 --set test.command="npm test -- dates.test.ts"',
    '<%= config.bin %> setup continue <setup-id> --version 2 --set scope.write=\'["src"]\' --set environment.install=npm',
    '<%= config.bin %> setup continue <setup-id> --version 3 --changes \'{"baseSha": null}\'',
  ];

  static args = {id: Args.string({description: 'Setup session ID', required: true})};

  static flags = {
    ...BaseCommand.baseFlags,
    version: Flags.integer({description: 'The version you are changing; a newer one is refused', required: true, min: 1}),
    set: Flags.string({description: 'field=value (JSON values are parsed; null clears); repeatable', multiple: true}),
    changes: Flags.string({description: 'JSON map of plan field to value (null clears)'}),
    provenance: Flags.string({description: 'JSON map of plan field to {source, detail}, for values you did not choose yourself'}),
    'idempotency-key': Flags.string({description: 'Repeat a lost request with the key it was sent with'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(SetupContinue);
    const scope = setupScope(flags.workspace, (flag) => this.workspaceId(flag));
    let changes: Record<string, unknown>;
    try {
      changes = {...this.parseJsonFlag<Record<string, unknown>>(flags.changes, 'changes'), ...parseSetPairs(flags.set ?? [])};
    } catch (error) {
      this.error((error as Error).message);
    }
    if (!Object.keys(changes).length) this.error('Name at least one change with --set or --changes.');
    const provenance = this.parseJsonFlag<Record<string, unknown>>(flags.provenance, 'provenance');
    const body = await this.apiRequest<{session: SetupSession}>(scopeFlags(flags, scope), `/api/v1/setup/sessions/${encodeURIComponent(args.id)}/revisions`, {
      method: 'POST',
      body: {workspaceId: setupWorkspace(scope), surface: 'cli', expectedVersion: flags.version, changes,
        ...(provenance ? {provenance} : {})},
      idempotencyKey: flags['idempotency-key'] ?? this.idempotencyKey(),
    });
    if (!this.jsonEnabled()) for (const line of describeSession(body.session, flags['api-url'])) this.log(line);
    return body;
  }
}
