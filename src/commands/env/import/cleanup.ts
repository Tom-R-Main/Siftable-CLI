import {Flags} from '@oclif/core';
import path from 'node:path';
import {BaseCommand} from '../../../lib/base-command.js';
import {createDotenvSourceBinding, MAX_DOTENV_IMPORT_BYTES} from '../../../lib/dotenvImport.js';
import {
  assertDotenvSourceIsNotManaged,
  resolveDotenvImportCheckoutRoot,
} from '../../../lib/dotenvImportPlan.js';
import {MAX_CSV_IMPORT_BYTES} from '../../../lib/csvImport.js';
import {readExplicitImportSource, readImportReceiptArtifact} from '../../../lib/envImportArtifacts.js';
import {
  enumerateSiblingArtifacts,
  removeImportedSource,
} from '../../../lib/envSourceCleanup.js';
import type {VaultImportDetailsResponse} from '../../../lib/csvImportTypes.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export interface EnvImportCleanupResult {
  removed: boolean;
  sourcePath: string;
  importId: string;
  plaintextRecallPossible: boolean;
  plaintextRemnantsMayRemain: boolean;
  siblingWarnings: Array<{path: string; kind: string}>;
}

export default class EnvImportCleanup extends BaseCommand {
  static summary = 'Remove one reviewed import source after a completed import';
  static description = 'Deletes exactly the identity-verified source file named by a matching import receipt, only after the server confirms the import completed. Sibling artifacts are reported as warnings and never deleted. Plaintext may remain in backups, history, logs, swap, or process memory: removal is reported honestly.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    source: Flags.string({required: true, description: 'Explicit import source file to remove'}),
    'receipt-file': Flags.string({required: true, description: 'Value-free import receipt from the completed apply'}),
    yes: Flags.boolean({required: true, description: 'Fresh human confirmation for this removal'}),
    'checkout-root': Flags.string({description: 'Checkout used only to reject Sift-managed source files'}),
  };

  async run(): Promise<EnvImportCleanupResult> {
    const {flags} = await this.parse(EnvImportCleanup);
    if (flags.yes !== true) {
      this.error('Source removal requires a fresh --yes confirmation for this invocation.');
    }
    const receipt = await readImportReceiptArtifact(flags['receipt-file']);
    if (path.resolve(flags.source) !== path.resolve(receipt.sourcePath)) {
      this.error('Import source does not match the reviewed import receipt; nothing was removed.');
    }
    const cap = receipt.dialect === 'sift-csv-v1' ? MAX_CSV_IMPORT_BYTES : MAX_DOTENV_IMPORT_BYTES;
    let snapshot;
    try {
      snapshot = await readExplicitImportSource(receipt.sourcePath, cap, 'Import');
    } catch {
      this.error('Import source is not a stable regular file; nothing was removed.');
      throw new Error('unreachable');
    }
    const checkoutRoot = await resolveDotenvImportCheckoutRoot(snapshot.path, flags['checkout-root']);
    await assertDotenvSourceIsNotManaged(snapshot, checkoutRoot).catch(() => {
      this.error('Sift-managed environment files cannot be removed by import cleanup; nothing was removed.');
      throw new Error('unreachable');
    });
    const rebound = createDotenvSourceBinding(snapshot.raw, receipt.sourceNonce);
    if (rebound.sourceDigest !== receipt.sourceDigest) {
      this.error('Import source changed after the reviewed import; nothing was removed.');
    }
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    if (receipt.ownerType !== owner.kind
      || (owner.kind === 'workspace' && receipt.ownerId !== owner.workspaceId)) {
      this.error('Selected Vault owner does not match the import receipt; nothing was removed.');
    }
    const response = await this.apiRequest<VaultImportDetailsResponse>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/imports/${encodeURIComponent(receipt.importId)}`,
      {method: 'GET'},
    );
    if (!response.import || response.import.id !== receipt.importId || response.import.status !== 'completed') {
      this.error('Server does not confirm a completed import for this receipt; nothing was removed.');
    }
    // The receipt is plain local JSON. Only the server-held plan binding
    // proves that this import was produced from a plan over these exact
    // source bytes, so a substituted receipt cannot authorize removing a
    // different file.
    const binding = response.import.planBinding;
    if (!binding
      || binding.status !== 'applied'
      || binding.planId !== receipt.planId
      || binding.planDigest !== receipt.planDigest
      || binding.dialect !== receipt.dialect
      || binding.sourceNonce !== receipt.sourceNonce
      || binding.sourceDigest !== rebound.sourceDigest) {
      this.error('Server-held import plan binding does not match this receipt and source; nothing was removed.');
    }
    const siblingWarnings = await enumerateSiblingArtifacts(snapshot.path);
    try {
      await removeImportedSource(snapshot);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Import source removal failed.');
    }
    const result: EnvImportCleanupResult = {
      removed: true,
      sourcePath: snapshot.path,
      importId: receipt.importId,
      plaintextRecallPossible: false,
      plaintextRemnantsMayRemain: true,
      siblingWarnings: siblingWarnings.map((warning) => ({path: warning.path, kind: warning.kind})),
    };
    if (!this.jsonEnabled()) {
      this.log(`Removed the file at ${snapshot.path}.`);
      this.log('Plaintext may remain in backups, shell history, logs, editor swap, or process memory.');
      if (siblingWarnings.length > 0) {
        this.log('Sibling artifacts were reported, not deleted:');
        for (const warning of siblingWarnings) {
          this.log(`  ${warning.kind}: ${warning.path}`);
        }
      }
    }
    return result;
  }
}
