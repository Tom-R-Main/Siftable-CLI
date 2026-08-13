import {Flags} from '@oclif/core';
import {randomBytes, randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BaseCommand, DEFAULT_API_URL} from '../../../lib/base-command.js';
import {resolveToken} from '../../../lib/auth.js';
import {buildEnvironmentBundleContract} from '../../../lib/environmentBundle.js';
import {loadEnvironmentManifest} from '../../../lib/environmentCommand.js';
import {
  environmentLeaseArtifactPath,
  cleanupEnvironmentLeaseArtifact,
  materializeEnvironmentLeaseArtifact,
  prepareEnvironmentLeaseRuntime,
  readEnvironmentLeaseRecord,
  removeEnvironmentLeaseRecord,
  sweepEnvironmentLeases,
  type EnvironmentLeaseArtifactPathClass,
} from '../../../lib/environmentLease.js';
import {
  registerEnvironmentLeaseSupervisorSignalCleanup,
  startEnvironmentLeaseSupervisor,
  type EnvironmentLeaseSupervisor,
} from '../../../lib/environmentLeaseSupervisor.js';
import {createMaterializationRedemptionProofBinding} from '../../../lib/environmentBundleCompatibility.js';
import type {ExecutionGrantEnvelope} from '../../../lib/localExecutionRunner.js';
import {
  createMaterializationArtifactBinding,
  createMaterializationBundleCredentialBinding,
  createMaterializationBundleRunnerProofBinding,
  createEnvironmentLeaseCleanupProofBinding,
  createMaterializerRunner,
  decryptMaterializationBundleEnvelope,
  decryptMaterializationEnvelope,
  signMaterializationRunnerProof,
} from '../../../lib/localMaterializer.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';
import {assertCanonicalApprovalUrl} from '../../../lib/vaultMaterializationSource.js';

type LeaseEndpointClass = 'development' | 'production' | 'ci' | 'shared_host';

interface LeaseRecord {
  contractVersion: 1;
  id: string;
  owner: string;
  bundleDigest: string;
  memberNames: string[];
  endpointClass: LeaseEndpointClass;
  consumer: string;
  holder: string;
  authorizationId: string | null;
  authorizationExpiresAt: string;
  expiresAt: string;
  artifactPathClass: EnvironmentLeaseArtifactPathClass;
  materializerDigest: string;
  runnerFingerprint: string;
  lifecycle: string;
  endpointEnrollment: {
    id: string;
    classification: string;
    storageTier: string;
    dedicated: boolean;
    policyEligible: boolean;
    killSwitchEnabled: boolean;
  };
  cleanup: {contractVersion: 1; state: string};
}

interface LeaseMaterializationRecord {
  id: string;
  approvalId: string;
  bundleMembers: Array<{name: string; vaultEntryId: string; credentialField: string}>;
  bundleDigest: string;
  endpointClass: LeaseEndpointClass;
  destinationPath: string;
  workspaceRoot: string;
  requestedMode: '0400' | '0600';
  expectedAbsence: boolean;
  observedStateBinding: string | null;
  expiresAt: string;
  sourceVersionDigest: string | null;
  lease: LeaseRecord;
}

function detectLeaseEndpoint(
  requested: LeaseEndpointClass,
  environment: NodeJS.ProcessEnv = process.env,
): LeaseEndpointClass {
  const detected = environment.CI
    || environment.GITHUB_ACTIONS
    || environment.GITLAB_CI
    || environment.CIRCLECI
    ? 'ci'
    : environment.CODESPACES || environment.GITPOD_WORKSPACE_ID
      ? 'shared_host'
      : null;
  if (detected && requested !== detected) {
    throw new Error(`Detected ${detected} endpoint must be declared as --endpoint-class ${detected}`);
  }
  return requested;
}

function sameMembers(
  actual: LeaseMaterializationRecord['bundleMembers'],
  expected: LeaseMaterializationRecord['bundleMembers'],
): boolean {
  return actual.length === expected.length && actual.every((member, index) => (
    member.name === expected[index]?.name
    && member.vaultEntryId === expected[index]?.vaultEntryId
    && member.credentialField === expected[index]?.credentialField
  ));
}

function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    return Promise.reject(new Error(message));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
    timer.unref();
    operation().then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default class VaultUseLease extends BaseCommand {
  static aliases = ['env lease'];
  static summary = 'Create one exact short-lived environment bundle artifact outside the Git worktree';
  static description = 'Uses the shared environment manifest and Vault resolver. Extensible consumers remain bounded by the exact credential scope and hard TTL; executable names and arguments are not a containment boundary. The artifact is never printed and must be cleaned through the versioned lease lifecycle.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    'checkout-root': Flags.string({description: 'Checkout containing .sift/environment.yaml'}),
    destination: Flags.string({description: 'Manifest destination used only to select one exact bundle'}),
    purpose: Flags.string({required: true}),
    consumer: Flags.string({required: true, description: 'Bound consumer identifier; not a command allowlist'}),
    holder: Flags.string({description: 'Bound holder identifier; defaults to the local runner fingerprint'}),
    'consumer-pid': Flags.integer({min: 1, description: 'Optional already-running consumer process lifetime'}),
    ttl: Flags.integer({default: 300, min: 30, max: 300}),
    'approval-timeout': Flags.integer({default: 600, min: 30, max: 600}),
    'endpoint-class': Flags.string({
      required: true,
      options: ['development', 'production', 'ci', 'shared_host'],
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultUseLease);
    const endpointClass = detectLeaseEndpoint(flags['endpoint-class'] as LeaseEndpointClass);
    const checkoutRoot = await realpath(path.resolve(flags['checkout-root'] ?? process.cwd()));
    const manifest = await loadEnvironmentManifest(checkoutRoot);
    const destinations = [...new Set(manifest.members
      .filter(member => member.kind === 'vault_field')
      .map(member => member.destination.path))];
    const selectedDestination = flags.destination
      ?? (destinations.length === 1 ? destinations[0] : undefined);
    if (!selectedDestination || !destinations.includes(selectedDestination)) {
      this.error('Choose one exact manifest bundle with --destination.');
    }
    const contract = buildEnvironmentBundleContract(manifest, checkoutRoot, selectedDestination);
    const ownerName = contract.owner.owner_type === 'personal'
      ? 'personal'
      : `workspace:${contract.owner.owner_id}`;
    const owner = resolveVaultOwnerContext({
      owner: flags.owner ?? ownerName,
      workspace: flags.workspace,
    });
    if (owner.owner !== ownerName) this.error('Manifest owner and selected Vault owner do not match.');
    const apiFlags = vaultApiFlags(flags, owner);
    const purpose = flags.purpose.trim();
    const runtime = await prepareEnvironmentLeaseRuntime({
      workspaceRoot: checkoutRoot,
    });
    const apiUrl = flags['api-url'] ?? process.env.SIFT_API_URL ?? process.env.EXF_API_URL ?? DEFAULT_API_URL;
    const supervisorToken = flags.token
      ?? process.env.SIFT_TOKEN
      ?? process.env.EXF_TOKEN
      ?? resolveToken();
    if (!supervisorToken) this.error('No authentication token found. Run `sift auth login` or set SIFT_TOKEN.');
    const runner = await createMaterializerRunner(apiUrl);
    if (!runner.privateKey) this.error('Vault lease runner identity is unavailable.');
    const runnerPrivateKey = runner.privateKey;
    const swept = await sweepEnvironmentLeases({runtimeRoot: runtime.root});
    for (const record of swept) {
      if (record.runnerFingerprint !== runner.fingerprint
        || !record.cleanupAttemptId || !record.cleanupReason
        || record.cleanupState === 'pending') continue;
      try {
        const proofTimestamp = new Date().toISOString();
        const proofBinding = createEnvironmentLeaseCleanupProofBinding({
          leaseId: record.leaseId,
          attemptId: record.cleanupAttemptId,
          state: record.cleanupState,
          reason: record.cleanupReason,
          runnerFingerprint: runner.fingerprint,
          materializerDigest: record.materializerDigest,
          proofTimestamp,
        });
        await withDeadline(
          () => this.apiRequest(
            apiFlags,
            `/api/v1/vault/materializations/leases/${encodeURIComponent(record.leaseId)}/cleanup`,
            {
              method: 'POST',
              body: {
                surface: 'cli',
                contextContractVersion: owner.contextContractVersion,
                attemptId: record.cleanupAttemptId,
                state: record.cleanupState,
                reason: record.cleanupReason,
                runnerFingerprint: runner.fingerprint,
                materializerDigest: record.materializerDigest,
                proofTimestamp,
                proof: signMaterializationRunnerProof(proofBinding, runnerPrivateKey),
              },
            },
          ),
          5_000,
          'Lease cleanup attestation timed out',
        );
        if (record.cleanupState === 'confirmed') {
          await removeEnvironmentLeaseRecord(runtime.root, record.leaseId);
        }
      } catch {
        // The value-free local record remains available for a later reconciliation.
      }
    }

    const leaseId = randomUUID();
    const destinationPath = environmentLeaseArtifactPath(runtime.root, leaseId);
    const holder = flags.holder ?? `runner:${runner.fingerprint}`;
    const nonce = randomBytes(32).toString('base64url');
    const runnerProofTimestamp = new Date().toISOString();
    const proofBinding = createMaterializationBundleRunnerProofBinding({
      bundleDigest: contract.memberSetDigest,
      destinationPath,
      workspaceRoot: checkoutRoot,
      requestedMode: contract.mode,
      expectedAbsence: true,
      overwriteConsent: false,
      purpose,
      requestNonce: nonce,
      runnerPublicKeyFingerprint: runner.fingerprint,
      materializerDigest: runner.materializerDigest,
      runnerProofTimestamp,
      vaultOwner: owner.owner,
      deliveryClass: 'ephemeral_lease',
      leaseId,
      leaseConsumer: flags.consumer,
      leaseHolder: holder,
      leaseTtlSeconds: flags.ttl,
      leaseArtifactPathClass: runtime.pathClass,
    });
    const expectedMembers = contract.members.map(member => ({
      name: member.name,
      vaultEntryId: member.entryId,
      credentialField: member.field,
    }));
    const first = contract.members[0]!;
    const requested = await this.apiRequest<{
      materialization: LeaseMaterializationRecord;
      artifactEnvelope: ExecutionGrantEnvelope;
      artifactBinding: string;
      approvalUrl: string;
    }>(apiFlags, '/api/v1/vault/materializations', {
      method: 'POST',
      body: {
        surface: 'cli',
        clientVersion: this.config.version,
        materializationContractVersion: 2,
        contextContractVersion: owner.contextContractVersion,
        vaultEntryId: first.entryId,
        credentialField: first.field,
        members: expectedMembers,
        memberSetDigest: contract.memberSetDigest,
        destinationPath,
        workspaceRoot: checkoutRoot,
        requestedMode: contract.mode,
        expectedAbsence: true,
        overwriteConsent: false,
        trackedFileException: false,
        riskyPathAcknowledged: true,
        plaintextDisclosureAcknowledged: true,
        purpose,
        requestNonce: nonce,
        runnerPublicKeyPem: runner.publicKeyPem,
        runnerPublicKeyFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        runnerProofTimestamp,
        runnerProof: signMaterializationRunnerProof(proofBinding, runnerPrivateKey),
        endpointClass,
        deliveryClass: 'ephemeral_lease',
        leaseId,
        leaseConsumer: flags.consumer,
        leaseHolder: holder,
        leaseTtlSeconds: flags.ttl,
        leaseArtifactPathClass: runtime.pathClass,
      },
    });
    const lease = requested.materialization.lease;
    if (!lease || lease.id !== requested.materialization.id
      || lease.bundleDigest !== contract.memberSetDigest
      || lease.consumer !== flags.consumer || lease.holder !== holder
      || lease.artifactPathClass !== runtime.pathClass
      || lease.endpointClass !== endpointClass
      || lease.runnerFingerprint !== runner.fingerprint
      || lease.materializerDigest !== runner.materializerDigest
      || requested.materialization.destinationPath !== destinationPath
      || requested.materialization.workspaceRoot !== checkoutRoot
      || requested.materialization.expectedAbsence !== true
      || !sameMembers(requested.materialization.bundleMembers, expectedMembers)) {
      this.error('Server lease binding differs from the exact local request.');
    }
    const artifactBinding = createMaterializationArtifactBinding({
      materializationId: requested.materialization.id,
      runnerFingerprint: runner.fingerprint,
      materializerDigest: runner.materializerDigest,
      nonce,
    });
    if (artifactBinding !== requested.artifactBinding) this.error('Lease artifact binding is invalid.');
    let artifact = decryptMaterializationEnvelope(
      requested.artifactEnvelope,
      runnerPrivateKey,
      artifactBinding,
      'vault_materialization_artifact',
      'artifact',
    );
    if (!this.jsonEnabled()) {
      this.log(`Approval: ${assertCanonicalApprovalUrl(requested.approvalUrl, requested.materialization.approvalId)}`);
      this.log(`Lease: ${lease.id} (${lease.artifactPathClass}, expires ${lease.expiresAt})`);
    }

    let values: Buffer[] = [];
    let redeemed = false;
    let locallyMaterialized = false;
    let disposeSignalCleanup: (() => void) | undefined;
    let supervisor: EnvironmentLeaseSupervisor | undefined;
    const attestLocalCleanup = async (record: {
      cleanupAttemptId: string | null;
      cleanupState: string;
      cleanupReason: string | null;
    }) => {
      if (!record.cleanupAttemptId || record.cleanupState === 'pending' || !record.cleanupReason) return;
      if (!['confirmed', 'not_required', 'failed', 'unknowable'].includes(record.cleanupState)) return;
      const state = record.cleanupState as 'confirmed' | 'not_required' | 'failed' | 'unknowable';
      const proofTimestamp = new Date().toISOString();
      const proofBinding = createEnvironmentLeaseCleanupProofBinding({
        leaseId: lease.id,
        attemptId: record.cleanupAttemptId,
        state,
        reason: record.cleanupReason,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        proofTimestamp,
      });
      await withDeadline(
        () => this.apiRequest(
          apiFlags,
          `/api/v1/vault/materializations/leases/${encodeURIComponent(lease.id)}/cleanup`,
          {
            method: 'POST',
            body: {
              surface: 'cli',
              contextContractVersion: owner.contextContractVersion,
              attemptId: record.cleanupAttemptId,
              state,
              reason: record.cleanupReason,
              runnerFingerprint: runner.fingerprint,
              materializerDigest: runner.materializerDigest,
              proofTimestamp,
              proof: signMaterializationRunnerProof(proofBinding, runnerPrivateKey),
            },
          },
        ),
        5_000,
        'Lease cleanup attestation timed out',
      );
      if (record.cleanupState === 'confirmed') {
        await removeEnvironmentLeaseRecord(runtime.root, lease.id);
      }
    };
    try {
      const deadline = Math.min(
        Date.now() + flags['approval-timeout'] * 1000,
        Date.parse(lease.expiresAt),
      );
      let approvalStatus = 'pending';
      while (Date.now() < deadline) {
        const approval = await this.apiRequest<{approval: {status: string}}>(
          apiFlags,
          `/api/v1/governed-approvals/${encodeURIComponent(requested.materialization.approvalId)}?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
        );
        approvalStatus = approval.approval.status;
        if (approvalStatus === 'approved') break;
        if (approvalStatus !== 'pending') this.error(`Lease approval is ${approvalStatus}.`);
        await delay(2_000);
      }
      if (approvalStatus !== 'approved') this.error('Lease approval timed out.');
      const redemptionProofTimestamp = new Date().toISOString();
      const redemptionProofBinding = createMaterializationRedemptionProofBinding({
        artifact,
        approvalId: requested.materialization.approvalId,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        requestNonce: nonce,
        runnerProofTimestamp: redemptionProofTimestamp,
      });
      const redemption = await this.apiRequest<{
        materialization: LeaseMaterializationRecord;
        envelope: ExecutionGrantEnvelope;
        binding: string;
      }>(apiFlags, '/api/v1/vault/materializations/redeem', {
        method: 'POST',
        body: {
          contextContractVersion: owner.contextContractVersion,
          artifact,
          approvalId: requested.materialization.approvalId,
          runnerFingerprint: runner.fingerprint,
          materializerDigest: runner.materializerDigest,
          requestNonce: nonce,
          runnerPublicKeyPem: runner.publicKeyPem,
          runnerProofTimestamp: redemptionProofTimestamp,
          runnerProof: signMaterializationRunnerProof(redemptionProofBinding, runnerPrivateKey),
        },
      });
      redeemed = true;
      const credentialBinding = createMaterializationBundleCredentialBinding({
        materializationId: requested.materialization.id,
        bundleDigest: contract.memberSetDigest,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        destinationPath,
        workspaceRoot: checkoutRoot,
        mode: contract.mode,
        expectedAbsence: true,
        purpose,
        nonce,
        deliveryClass: 'ephemeral_lease',
        leaseConsumer: flags.consumer,
        leaseHolder: holder,
        leaseExpiresAt: lease.expiresAt,
        leaseArtifactPathClass: runtime.pathClass,
        endpointEnrollmentId: lease.endpointEnrollment.id,
        endpointClassification: lease.endpointEnrollment.classification,
        endpointStorageTier: lease.endpointEnrollment.storageTier,
        endpointDedicated: lease.endpointEnrollment.dedicated,
        endpointPolicyEligible: lease.endpointEnrollment.policyEligible,
        endpointKillSwitchEnabled: lease.endpointEnrollment.killSwitchEnabled,
      });
      if (redemption.binding !== credentialBinding
        || redemption.materialization.lease?.expiresAt !== lease.expiresAt) {
        this.error('Lease credential binding is invalid.');
      }
      values = decryptMaterializationBundleEnvelope(
        redemption.envelope,
        runnerPrivateKey,
        credentialBinding,
        contract.members.map(member => member.name),
      );
      await materializeEnvironmentLeaseArtifact({
        contract,
        values,
        leaseId: lease.id,
        consumer: flags.consumer,
        holder,
        purpose,
        authorizationId: requested.materialization.approvalId,
        authorizationExpiresAt: lease.authorizationExpiresAt,
        expiresAt: lease.expiresAt,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        consumerPid: flags['consumer-pid'],
        runtime,
        onPrepared: async () => {
          supervisor = startEnvironmentLeaseSupervisor({
            runtimeRoot: runtime.root,
            leaseId: lease.id,
            expiresAt: lease.expiresAt,
            consumerPid: flags['consumer-pid'],
            apiUrl,
            token: supervisorToken,
            workspaceId: owner.workspaceId,
            contextContractVersion: owner.contextContractVersion,
            runnerFingerprint: runner.fingerprint,
            materializerDigest: runner.materializerDigest,
            privateKey: runnerPrivateKey,
          });
          await supervisor.armed;
          disposeSignalCleanup = registerEnvironmentLeaseSupervisorSignalCleanup(supervisor);
        },
      });
      locallyMaterialized = true;
      await withDeadline(
        () => this.apiRequest(
          apiFlags,
          `/api/v1/vault/materializations/${encodeURIComponent(lease.id)}/complete`,
          {
            method: 'POST',
            body: {
              surface: 'cli',
              contextContractVersion: owner.contextContractVersion,
              requestNonce: nonce,
              destinationState: 'leased',
              mode: contract.mode,
              cleanupSucceeded: true,
            },
          },
        ),
        Math.min(5_000, Date.parse(lease.expiresAt) - Date.now() - 1),
        'Lease completion receipt exceeded the remaining plaintext TTL',
      );
      if (!this.jsonEnabled()) {
        this.log(flags['consumer-pid']
          ? `Lease is active until consumer PID ${flags['consumer-pid']} exits or ${lease.expiresAt}.`
          : `Lease is active until ${lease.expiresAt}.`);
      }
      if (!supervisor) throw new Error('Lease supervisor did not arm before materialization');
      const cleanup = await supervisor.completed;
      disposeSignalCleanup?.();
      const result = {
        id: lease.id,
        owner: lease.owner,
        bundleDigest: lease.bundleDigest,
        consumer: lease.consumer,
        holder: lease.holder,
        endpointClass: lease.endpointClass,
        expiresAt: lease.expiresAt,
        artifactPathClass: lease.artifactPathClass,
        cleanupState: cleanup.cleanupState,
      };
      if (!this.jsonEnabled()) this.log(`Lease ended with cleanup=${cleanup.cleanupState}. Its path and values were never printed.`);
      return result;
    } catch (error) {
      disposeSignalCleanup?.();
      if (supervisor) {
        supervisor.cleanup('cancellation');
        await withDeadline(
          () => supervisor!.completed,
          5_000,
          'Lease supervisor cleanup timed out',
        ).catch(() => undefined);
      } else {
        const localRecord = await readEnvironmentLeaseRecord(runtime.root, lease.id)
          .catch(() => undefined);
        if (localRecord) {
          const cleanup = await cleanupEnvironmentLeaseArtifact({
            runtimeRoot: runtime.root,
            leaseId: lease.id,
            reason: 'cancellation',
          }).catch(() => null);
          if (cleanup) await attestLocalCleanup(cleanup).catch(() => undefined);
        } else {
          await attestLocalCleanup({
            cleanupAttemptId: randomUUID(),
            cleanupState: 'not_required',
            cleanupReason: 'cancellation',
          }).catch(() => undefined);
        }
      }
      try {
        await this.apiRequest(
          apiFlags,
          `/api/v1/vault/materializations/${encodeURIComponent(lease.id)}/${redeemed ? 'fail' : 'revoke'}`,
          {
            method: 'POST',
            body: redeemed
              ? {
                surface: 'cli',
                contextContractVersion: owner.contextContractVersion,
                requestNonce: nonce,
                failureCode: locallyMaterialized ? 'receipt_failed' : 'local_write_failed',
                // This legacy field describes staging cleanup. Lease artifact
                // cleanup is attested through its separate versioned state.
                cleanupSucceeded: true,
              }
              : {surface: 'cli', contextContractVersion: owner.contextContractVersion},
          },
        );
      } catch {
        // The bounded request expires server-side and startup sweep handles any local artifact.
      }
      throw error;
    } finally {
      artifact = '';
      for (const value of values) value.fill(0);
      runner.privateKey = null;
    }
  }
}
