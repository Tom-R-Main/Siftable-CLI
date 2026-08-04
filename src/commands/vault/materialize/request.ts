import {Flags} from '@oclif/core';
import {readFile} from 'node:fs/promises';
import {BaseCommand} from '../../../lib/base-command.js';
import {resolveMaterializationRoot} from '../../../lib/materialization-root.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';
import {
  assertCanonicalApprovalUrl,
  ownerFlagsForMaterializationSource,
  type SafeMaterializationSource,
  withMaterializationSourceRecovery,
} from '../materialization-source.js';

export default class VaultMaterializeRequest extends BaseCommand {
  static description = 'Request human approval for one destination-bound Vault materialization';
  static flags = {
    ...BaseCommand.baseFlags,
    entry: Flags.string({required: true}),
    field: Flags.string({required: true}),
    destination: Flags.string({required: true}),
    'workspace-root': Flags.string({
      description: 'Absolute local workspace root containing the destination',
    }),
    mode: Flags.string({options: ['0400', '0600'], default: '0600'}),
    purpose: Flags.string({required: true}),
    nonce: Flags.string({required: true}),
    'expected-digest': Flags.string(),
    overwrite: Flags.boolean({default: false}),
    'tracked-exception': Flags.boolean({default: false}),
    'runner-public-key': Flags.string({required: true}),
    'runner-fingerprint': Flags.string({required: true}),
    'materializer-digest': Flags.string({required: true}),
    owner: vaultOwnerFlag,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultMaterializeRequest);
    const root = resolveMaterializationRoot(flags);
    if (root.usedLegacyAlias && !this.jsonEnabled()) {
      this.warn('Using --workspace as a local path is deprecated. Use --workspace-root; --workspace identifies a collaborative tenant.');
    }
    const sourceFlags = ownerFlagsForMaterializationSource(flags, {
      legacyMaterializationAlias: root.usedLegacyAlias,
    });
    const owner = resolveVaultOwnerContext(sourceFlags, {
      legacyMaterializationAlias: root.usedLegacyAlias,
    });
    const apiFlags = vaultApiFlags(sourceFlags, owner);
    const source = await withMaterializationSourceRecovery(
      () => this.apiRequest<{entry: SafeMaterializationSource}>(
        apiFlags,
        `/api/v1/vault/materializations/sources/resolve?surface=cli&contextContractVersion=${owner.contextContractVersion}&ref=${encodeURIComponent(flags.entry)}`,
      ),
      flags.entry,
      owner.owner,
    );
    if (!source.entry.credentialFields.includes(flags.field)) {
      throw new Error(
        `Vault field ${JSON.stringify(flags.field)} is unavailable. Run sift vault search ${JSON.stringify(source.entry.slug)} --owner ${source.entry.owner}.`,
      );
    }
    const response = await this.apiRequest<{
      materialization: Record<string, unknown>;
      artifactEnvelope: Record<string, unknown>;
      artifactBinding: string;
      approvalUrl: string;
    }>(
      apiFlags,
      '/api/v1/vault/materializations',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          contextContractVersion: owner.contextContractVersion,
          vaultEntryId: source.entry.id,
          credentialField: flags.field,
          destinationPath: flags.destination,
          workspaceRoot: root.workspaceRoot,
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
      this.log(`Approval: ${assertCanonicalApprovalUrl(
        response.approvalUrl,
        String(response.materialization.approvalId),
      )}`);
      this.log('Warning: approval authorizes plaintext at rest at the exact displayed path.');
      this.log('The artifact is encrypted to the prepared runner; no plaintext or bearer artifact was emitted.');
    }
    return response;
  }
}
