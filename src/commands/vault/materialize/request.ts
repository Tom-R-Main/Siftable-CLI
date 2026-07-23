import {Flags} from '@oclif/core';
import {readFile} from 'node:fs/promises';
import {BaseCommand} from '../../../lib/base-command.js';

export default class VaultMaterializeRequest extends BaseCommand {
  static description = 'Request human approval for one destination-bound Vault materialization';
  static flags = {
    ...BaseCommand.baseFlags,
    entry: Flags.string({required: true}),
    field: Flags.string({required: true}),
    destination: Flags.string({required: true}),
    workspace: Flags.string({required: true}),
    mode: Flags.string({options: ['0400', '0600'], default: '0600'}),
    purpose: Flags.string({required: true}),
    nonce: Flags.string({required: true}),
    'expected-digest': Flags.string(),
    overwrite: Flags.boolean({default: false}),
    'tracked-exception': Flags.boolean({default: false}),
    'runner-public-key': Flags.string({required: true}),
    'runner-fingerprint': Flags.string({required: true}),
    'materializer-digest': Flags.string({required: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultMaterializeRequest);
    const response = await this.apiRequest<{
      materialization: Record<string, unknown>;
      artifactEnvelope: Record<string, unknown>;
      artifactBinding: string;
    }>(
      flags,
      '/api/v1/vault/materializations',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          vaultEntryId: flags.entry,
          credentialField: flags.field,
          destinationPath: flags.destination,
          workspaceRoot: flags.workspace,
          requestedMode: flags.mode,
          expectedAbsence: !flags['expected-digest'],
          expectedDestinationDigest: flags['expected-digest'],
          overwriteConsent: flags.overwrite,
          trackedFileException: flags['tracked-exception'],
          plaintextDisclosureAcknowledged: true,
          purpose: flags.purpose,
          requestNonce: flags.nonce,
          runnerPublicKeyPem: await readFile(flags['runner-public-key'], 'utf8'),
          runnerPublicKeyFingerprint: flags['runner-fingerprint'],
          materializerDigest: flags['materializer-digest'],
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Materialization requested: ${response.materialization.id}`);
      this.log(`Approval: ${response.materialization.approvalId}`);
      this.log('Warning: approval authorizes plaintext at rest at the exact displayed path.');
      this.log('The artifact is encrypted to the prepared runner; no plaintext or bearer artifact was emitted.');
    }
    return response;
  }
}
