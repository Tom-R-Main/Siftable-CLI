import {Args, Flags} from '@oclif/core';
import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {BaseCommand, DEFAULT_API_URL} from '../../../lib/base-command.js';
import {
  cleanupEnvironmentLeaseArtifact,
  prepareEnvironmentLeaseRuntime,
  readEnvironmentLeaseRecord,
  removeEnvironmentLeaseRecord,
} from '../../../lib/environmentLease.js';
import {
  projectEnvironmentLeaseMetadata,
  type EnvironmentLeaseApiRecord,
} from '../../../lib/environmentLeaseApi.js';
import {
  createEnvironmentLeaseCleanupProofBinding,
  createMaterializerRunner,
  signMaterializationRunnerProof,
} from '../../../lib/localMaterializer.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class VaultLeasesClean extends BaseCommand {
  static aliases = ['env leases clean'];
  static description = 'Clean one local lease artifact and attest confirmed, failed, or unknowable state';
  static args = {id: Args.string({required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    'checkout-root': Flags.string({description: 'Git checkout used to prove runtime separation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultLeasesClean);
    const checkoutRoot = await realpath(path.resolve(flags['checkout-root'] ?? process.cwd()));
    const runtime = await prepareEnvironmentLeaseRuntime({
      workspaceRoot: checkoutRoot,
    });
    const attemptId = randomUUID();
    const existing = await readEnvironmentLeaseRecord(runtime.root, args.id);
    const local = existing
      ? await cleanupEnvironmentLeaseArtifact({
        runtimeRoot: runtime.root,
        leaseId: args.id,
        reason: 'cancellation',
        attemptId,
      })
      : null;
    const state = local?.cleanupState === 'confirmed'
      ? 'confirmed'
      : local?.cleanupState === 'failed'
        ? 'failed'
        : 'unknowable';
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    const apiFlags = vaultApiFlags(flags, owner);
    const inspected = await this.apiRequest<{lease: EnvironmentLeaseApiRecord}>(
      apiFlags,
      `/api/v1/vault/materializations/leases/${encodeURIComponent(args.id)}`
        + `?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
    );
    const runner = await createMaterializerRunner(
      flags['api-url'] ?? process.env.SIFT_API_URL ?? process.env.EXF_API_URL ?? DEFAULT_API_URL,
    );
    if (!runner.privateKey) this.error('Vault lease runner identity is unavailable.');
    const runnerFingerprint = local?.runnerFingerprint ?? inspected.lease.runnerFingerprint;
    const materializerDigest = local?.materializerDigest ?? inspected.lease.materializerDigest;
    if (runnerFingerprint !== runner.fingerprint) this.error('Lease belongs to a different enrolled endpoint.');
    const proofTimestamp = new Date().toISOString();
    const proofBinding = createEnvironmentLeaseCleanupProofBinding({
      leaseId: args.id,
      attemptId,
      state,
      reason: 'cancellation',
      runnerFingerprint,
      materializerDigest,
      proofTimestamp,
    });
    const response = await this.apiRequest<{lease: EnvironmentLeaseApiRecord}>(
      apiFlags,
      `/api/v1/vault/materializations/leases/${encodeURIComponent(args.id)}/cleanup`,
      {
        method: 'POST',
        body: {
          surface: 'cli',
          contextContractVersion: owner.contextContractVersion,
          attemptId,
          state,
          reason: 'cancellation',
          runnerFingerprint,
          materializerDigest,
          proofTimestamp,
          proof: signMaterializationRunnerProof(proofBinding, runner.privateKey),
        },
      },
    );
    const lease = projectEnvironmentLeaseMetadata(response.lease);
    if (local?.cleanupState === 'confirmed') {
      await removeEnvironmentLeaseRecord(runtime.root, args.id);
    }
    if (!this.jsonEnabled()) this.log(`Lease ${lease.id}: cleanup=${lease.cleanup.state}`);
    return lease;
  }
}
