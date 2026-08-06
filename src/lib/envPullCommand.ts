import {Flags} from '@oclif/core';
import {randomBytes} from 'node:crypto';
import {mkdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BaseCommand, DEFAULT_API_URL} from './base-command.js';
import {
  buildEnvironmentBundleContract,
  assertManagedEnvironmentBundleGitSafety,
  inspectManagedEnvironmentBundle,
  materializeManagedEnvironmentBundle,
  privateObservedEnvironmentDigest,
  readManagedEnvironmentBundleReceipt,
  writeManagedEnvironmentBundleReceipt,
} from './environmentBundle.js';
import {assertDestinationSafeBeforeApproval} from './environmentCheckoutSafety.js';
import {loadEnvironmentManifest} from './environmentCommand.js';
import {
  createMaterializationArtifactBinding,
  createMaterializationBundleRunnerProofBinding,
  createMaterializationBundleCredentialBinding,
  createMaterializerRunner,
  decryptMaterializationBundleEnvelope,
  decryptMaterializationEnvelope,
  signMaterializationRunnerProof,
} from './localMaterializer.js';
import type {ExecutionGrantEnvelope} from './localExecutionRunner.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from './vault-owner-context.js';
import {assertCanonicalApprovalUrl} from './vaultMaterializationSource.js';

interface BundleMaterializationRecord {
  id: string;
  approvalId: string;
  bundleMembers: Array<{name: string; vaultEntryId: string; credentialField: string}>;
  bundleDigest: string;
  valueVersionState: 'unchanged' | 'rotated_since_approval' | 'unknown';
  sourceVersionDigest: string | null;
  endpointClass: EnvironmentEndpointClass;
  destinationPath: string;
  workspaceRoot: string;
  requestedMode: '0400' | '0600';
  expectedAbsence: boolean;
  observedStateBinding: string | null;
  status: string;
}

const RECOVERY_COMMAND = 'sift env pull --help';
const BROKER_COMMAND = 'sift grants run --help';

function sameBundleMembers(
  left: BundleMaterializationRecord['bundleMembers'],
  right: BundleMaterializationRecord['bundleMembers'],
): boolean {
  return left.length === right.length && left.every((member, index) => (
    member.name === right[index]?.name
    && member.vaultEntryId === right[index]?.vaultEntryId
    && member.credentialField === right[index]?.credentialField
  ));
}

export type EnvironmentEndpointClass =
  | 'development'
  | 'production'
  | 'ci'
  | 'shared_host'
  | 'policy_ineligible';

const CI_SIGNALS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD',
  'JENKINS_URL', 'TEAMCITY_VERSION', 'BITBUCKET_BUILD_NUMBER',
] as const;
const SHARED_HOST_SIGNALS = ['CODESPACES', 'GITPOD_WORKSPACE_ID', 'REPL_ID'] as const;

function signalPresent(value: string | undefined): boolean {
  return Boolean(value && !/^(?:0|false|no|off)$/i.test(value));
}

export function classifyEnvironmentEndpoint(
  explicitClass: EnvironmentEndpointClass | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): EnvironmentEndpointClass {
  const detected = CI_SIGNALS.some(name => signalPresent(environment[name]))
    ? 'ci'
    : SHARED_HOST_SIGNALS.some(name => signalPresent(environment[name]))
      ? 'shared_host'
      : undefined;
  if (detected) {
    throw new Error(`Managed environment pull is blocked on detected ${detected} endpoints; use ${BROKER_COMMAND}`);
  }
  if (!explicitClass) {
    throw new Error('Managed environment pull requires an explicit --endpoint-class; no development default is assumed');
  }
  if (explicitClass !== 'development') {
    throw new Error(`Managed environment pull is unavailable for ${explicitClass} endpoints; use ${BROKER_COMMAND}`);
  }
  return explicitClass;
}

export default class EnvPull extends BaseCommand {
  static aliases: string[] = [];
  static summary = 'Pull one exact governed Vault bundle into a Sift-managed development environment file';
  static description = 'Resolves every manifest member before one atomic commit. Production, CI, shared-host, and policy-ineligible endpoints use broker execution instead.';
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    'checkout-root': Flags.string({description: 'Checkout containing .sift/environment.yaml'}),
    destination: Flags.string({description: 'Exact relative destination when the manifest declares more than one bundle'}),
    purpose: Flags.string({required: true}),
    replace: Flags.boolean({default: false, description: 'Replace a changed Sift-managed file using its exact observed precondition'}),
    'approval-timeout': Flags.integer({default: 600, min: 30, max: 600}),
    'endpoint-class': Flags.string({
      options: ['development', 'production', 'ci', 'shared_host', 'policy_ineligible'],
      required: true,
      description: 'Explicit endpoint policy class; managed pulls accept development only',
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EnvPull);
    const endpointClass = classifyEnvironmentEndpoint(
      flags['endpoint-class'] as EnvironmentEndpointClass | undefined,
    );
    const checkoutRoot = await realpath(path.resolve(flags['checkout-root'] ?? process.cwd()));
    const manifest = await loadEnvironmentManifest(checkoutRoot);
    const destinations = [...new Set(manifest.members
      .filter(member => member.kind === 'vault_field')
      .map(member => member.destination.path))];
    const destination = flags.destination ?? (destinations.length === 1 ? destinations[0] : undefined);
    if (!destination || !destinations.includes(destination)) {
      this.error('Choose one exact Vault bundle destination with --destination.', {suggestions: [RECOVERY_COMMAND]});
    }
    const contract = buildEnvironmentBundleContract(manifest, checkoutRoot, destination);
    await mkdir(path.dirname(contract.destinationPath), {recursive: true, mode: 0o700});
    await assertDestinationSafeBeforeApproval(checkoutRoot, contract.relativeDestination);
    await assertManagedEnvironmentBundleGitSafety(contract);

    const ownerName = contract.owner.owner_type === 'personal'
      ? 'personal'
      : `workspace:${contract.owner.owner_id}`;
    const owner = resolveVaultOwnerContext({
      owner: flags.owner ?? ownerName,
      workspace: flags.workspace,
    });
    if (owner.owner !== ownerName) this.error('Manifest owner and selected Vault owner do not match.');
    const apiFlags = vaultApiFlags(flags, owner);

    const previousReceipt = await readManagedEnvironmentBundleReceipt(contract);
    const inspection = await inspectManagedEnvironmentBundle(contract, previousReceipt);
    const managedRefresh = inspection.state === 'managed_current';
    if (inspection.state !== 'absent' && !managedRefresh && !flags.replace) {
      this.error(`${inspection.state}: use --replace to consent to replacing the exact observed managed file.`, {
        suggestions: [RECOVERY_COMMAND],
      });
    }

    const expectedAbsence = inspection.state === 'absent';
    const expectedDestinationState = inspection.observedState;
    const expectedDestinationDigest = privateObservedEnvironmentDigest(inspection);
    if (!expectedAbsence && !expectedDestinationDigest) {
      this.error('The managed destination could not be bound to its exact local contents.');
    }
    const observedStateBinding = expectedAbsence
      ? undefined
      : randomBytes(32).toString('base64url');
    const runner = await createMaterializerRunner(
      flags['api-url'] ?? process.env.SIFT_API_URL ?? DEFAULT_API_URL,
    );
    if (!runner.privateKey) this.error('Vault materializer device identity is unavailable.');
    const nonce = randomBytes(32).toString('base64url');
    const runnerProofTimestamp = new Date().toISOString();
    const runnerProofBinding = runner.sessionEligible
      ? createMaterializationBundleRunnerProofBinding({
        bundleDigest: contract.memberSetDigest,
        destinationPath: contract.destinationPath,
        workspaceRoot: contract.checkoutRoot,
        requestedMode: contract.mode,
        expectedAbsence,
        observedStateBinding,
        overwriteConsent: !expectedAbsence && (flags.replace || managedRefresh),
        purpose: flags.purpose,
        requestNonce: nonce,
        runnerPublicKeyFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        runnerProofTimestamp,
        vaultOwner: owner.owner,
      })
      : null;
    const first = contract.members[0]!;
    let requested: {
      materialization: BundleMaterializationRecord;
      artifactEnvelope: ExecutionGrantEnvelope;
      artifactBinding: string;
      approvalUrl: string;
    };
    try {
      requested = await this.apiRequest(apiFlags, '/api/v1/vault/materializations', {
        method: 'POST',
        body: {
        surface: 'cli',
        contextContractVersion: owner.contextContractVersion,
        vaultEntryId: first.entryId,
        credentialField: first.field,
        members: contract.members.map(member => ({
          name: member.name,
          vaultEntryId: member.entryId,
          credentialField: member.field,
        })),
        memberSetDigest: contract.memberSetDigest,
        destinationPath: contract.destinationPath,
        workspaceRoot: contract.checkoutRoot,
        requestedMode: contract.mode,
        expectedAbsence,
        observedStateBinding,
        overwriteConsent: !expectedAbsence && (flags.replace || managedRefresh),
        trackedFileException: false,
        riskyPathAcknowledged: true,
        plaintextDisclosureAcknowledged: true,
        purpose: flags.purpose,
        requestNonce: nonce,
        runnerPublicKeyPem: runner.publicKeyPem,
        runnerPublicKeyFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        ...(runnerProofBinding ? {
          runnerProofTimestamp,
          runnerProof: signMaterializationRunnerProof(runnerProofBinding, runner.privateKey),
        } : {}),
        endpointClass,
        },
      });
    } catch (error) {
      runner.privateKey = null;
      if (managedRefresh && error instanceof TypeError) {
        const result = {
          state: 'managed_unknown_freshness',
          destination: contract.relativeDestination,
          memberSetDigest: contract.memberSetDigest,
          lastCheckedAt: previousReceipt?.lastCheckedAt ?? null,
          approvalConsumed: false,
        };
        if (!this.jsonEnabled()) {
          this.log(`Freshness unknown while offline: ${contract.relativeDestination}`);
        }
        return result;
      }
      throw error;
    }

    const expectedMembers = contract.members.map(member => ({
      name: member.name,
      vaultEntryId: member.entryId,
      credentialField: member.field,
    }));
    if (requested.materialization.bundleDigest !== contract.memberSetDigest
      || !sameBundleMembers(requested.materialization.bundleMembers, expectedMembers)
      || requested.materialization.destinationPath !== contract.destinationPath
      || requested.materialization.workspaceRoot !== contract.checkoutRoot
      || requested.materialization.requestedMode !== contract.mode
      || requested.materialization.expectedAbsence !== expectedAbsence
      || requested.materialization.observedStateBinding !== (observedStateBinding ?? null)
      || requested.materialization.endpointClass !== endpointClass) {
      this.error('Server materialization binding differs from the exact local bundle.', {suggestions: [RECOVERY_COMMAND]});
    }
    const artifactBinding = createMaterializationArtifactBinding({
      materializationId: requested.materialization.id,
      runnerFingerprint: runner.fingerprint,
      materializerDigest: runner.materializerDigest,
      nonce,
    });
    if (artifactBinding !== requested.artifactBinding) this.error('Materialization artifact binding is invalid.');
    let artifact = decryptMaterializationEnvelope(
      requested.artifactEnvelope,
      runner.privateKey,
      artifactBinding,
      'vault_materialization_artifact',
      'artifact',
    );
    if (!this.jsonEnabled()) {
      this.log(`Approval: ${assertCanonicalApprovalUrl(requested.approvalUrl, requested.materialization.approvalId)}`);
      this.log(`Bundle: ${contract.members.length} named members → ${contract.relativeDestination}`);
    }

    let values: Buffer[] = [];
    let redeemed = false;
    let localWriteCompleted = false;
    let cleanupSucceeded = false;
    try {
      const deadline = Date.now() + flags['approval-timeout'] * 1000;
      let approvalStatus = 'pending';
      while (Date.now() < deadline) {
        const approval = await this.apiRequest<{approval: {status: string}}>(
          apiFlags,
          `/api/v1/governed-approvals/${encodeURIComponent(requested.materialization.approvalId)}?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
        );
        approvalStatus = approval.approval.status;
        if (approvalStatus === 'approved') break;
        if (approvalStatus !== 'pending') this.error(`Materialization approval is ${approvalStatus}.`);
        await delay(2_000);
      }
      if (approvalStatus !== 'approved') this.error('Materialization approval timed out.');
      const redemption = await this.apiRequest<{
        materialization: BundleMaterializationRecord;
        envelope: ExecutionGrantEnvelope;
        binding: string;
      }>(apiFlags, '/api/v1/vault/materializations/redeem', {
        method: 'POST',
        body: {
          surface: 'cli',
          contextContractVersion: owner.contextContractVersion,
          artifact,
          approvalId: requested.materialization.approvalId,
          runnerFingerprint: runner.fingerprint,
          materializerDigest: runner.materializerDigest,
          requestNonce: nonce,
        },
      });
      redeemed = true;
      if (redemption.materialization.bundleDigest !== contract.memberSetDigest
        || !sameBundleMembers(redemption.materialization.bundleMembers, expectedMembers)) {
        this.error('Bundle membership changed after approval.');
      }
      const credentialBinding = createMaterializationBundleCredentialBinding({
        materializationId: requested.materialization.id,
        bundleDigest: contract.memberSetDigest,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        destinationPath: contract.destinationPath,
        workspaceRoot: contract.checkoutRoot,
        mode: contract.mode,
        expectedAbsence,
        observedStateBinding,
        purpose: flags.purpose,
        nonce,
      });
      if (redemption.binding !== credentialBinding) this.error('Bundle credential binding is invalid.');
      values = decryptMaterializationBundleEnvelope(
        redemption.envelope,
        runner.privateKey,
        credentialBinding,
        contract.members.map(member => member.name),
      );
      const writtenReceipt = await materializeManagedEnvironmentBundle({
        contract,
        values,
        expectedAbsence,
        expectedDestinationState,
        expectedDestinationDigest,
        replacementConsentState: flags.replace || managedRefresh ? expectedDestinationState : undefined,
        onCommitted: () => {
          localWriteCompleted = true;
        },
        onCleanup: succeeded => {
          cleanupSucceeded = succeeded;
        },
      });
      if (!redemption.materialization.sourceVersionDigest) {
        this.error('Server omitted the value-free source version receipt.');
      }
      const receipt = {
        ...writtenReceipt,
        lastCheckedAt: new Date().toISOString(),
        sourceVersionDigest: redemption.materialization.sourceVersionDigest,
      };
      await writeManagedEnvironmentBundleReceipt(contract, receipt);
      const written = await inspectManagedEnvironmentBundle(contract, receipt);
      if (written.state !== 'managed_current') this.error('Managed destination failed post-write verification.');
      const completed = await this.apiRequest<{receipt: BundleMaterializationRecord}>(
        apiFlags,
        `/api/v1/vault/materializations/${encodeURIComponent(requested.materialization.id)}/complete`,
        {
          method: 'POST',
          body: {
            surface: 'cli',
            contextContractVersion: owner.contextContractVersion,
            requestNonce: nonce,
            destinationState: 'written',
            mode: receipt.mode,
            cleanupSucceeded,
          },
        },
      );
      const result = {
        state: 'managed_current',
        destination: contract.relativeDestination,
        mode: receipt.mode,
        memberSetDigest: contract.memberSetDigest,
        memberCount: contract.members.length,
        valueVersionState: redemption.materialization.valueVersionState,
        approvalConsumed: true,
        materializationId: completed.receipt.id,
      };
      if (!this.jsonEnabled()) this.log(`Materialized ${result.memberCount} members with mode ${result.mode}.`);
      return result;
    } catch (error) {
      try {
        await this.apiRequest(
          apiFlags,
          `/api/v1/vault/materializations/${encodeURIComponent(requested.materialization.id)}/${redeemed ? 'fail' : 'revoke'}`,
          {
            method: 'POST',
            body: redeemed
              ? {
                surface: 'cli',
                contextContractVersion: owner.contextContractVersion,
                requestNonce: nonce,
                failureCode: localWriteCompleted ? 'receipt_failed' : 'local_write_failed',
                cleanupSucceeded,
              }
              : {surface: 'cli', contextContractVersion: owner.contextContractVersion},
          },
        );
      } catch {
        // Preserve the original bounded failure; the request expires server-side.
      }
      throw error;
    } finally {
      artifact = '';
      for (const value of values) value.fill(0);
      runner.privateKey = null;
    }
  }
}
