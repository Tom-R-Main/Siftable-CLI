import {Flags} from '@oclif/core';
import {readFile} from 'node:fs/promises';
import {BaseCommand} from '../../lib/base-command.js';
import {parseStringMap} from '../../lib/execution-grant-input.js';

export default class GrantsRequest extends BaseCommand {
  static description = 'Request a human-approved grant for a pre-registered trusted local runner';
  static flags = {
    ...BaseCommand.baseFlags,
    'vault-entry': Flags.string({required: true}),
    'credential-field': Flags.string({required: true}),
    issuer: Flags.string({required: true}),
    adapter: Flags.string({required: true}),
    operation: Flags.string({required: true}),
    audience: Flags.string({required: true}),
    scope: Flags.string({required: true, description: 'Provider scope JSON with string values'}),
    purpose: Flags.string({required: true}),
    'runner-public-key': Flags.string({required: true, description: 'PEM public-key file from the trusted local runner'}),
    'runner-fingerprint': Flags.string({required: true}),
    executable: Flags.string({required: true, description: 'Resolved reviewed executable path'}),
    'executable-digest': Flags.string({required: true}),
    cwd: Flags.string(),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(GrantsRequest);
    const response = await this.apiRequest<{
      grant: Record<string, unknown>;
      handleEnvelope: Record<string, unknown>;
      handleBinding: string;
    }>(
      flags,
      '/api/v1/vault/execution-grants',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          vaultEntryId: flags['vault-entry'],
          credentialField: flags['credential-field'],
          issuerId: flags.issuer,
          adapterId: flags.adapter,
          operation: flags.operation,
          audience: flags.audience,
          requestedScope: parseStringMap(flags.scope, '--scope'),
          purpose: flags.purpose,
          runnerPublicKeyPem: await readFile(flags['runner-public-key'], 'utf8'),
          runnerPublicKeyFingerprint: flags['runner-fingerprint'],
          executablePath: flags.executable,
          executableDigest: flags['executable-digest'],
          workingDirectory: flags.cwd,
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Grant requested: ${response.grant.id}`);
      this.log(`Approval: ${response.grant.approvalId}`);
      this.log('The single-use handle is encrypted to the matching runner; no plaintext handle was emitted.');
    }
    return response;
  }
}
