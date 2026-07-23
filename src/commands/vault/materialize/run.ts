import {Flags} from '@oclif/core';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  createMaterializationArtifactBinding,
  createMaterializationCredentialBinding,
  createMaterializerRunner,
  decryptMaterializationEnvelope,
  inspectMaterializationDestination,
  materializeApprovedPlaintext,
  type MaterializationReceipt,
} from '../../../lib/localMaterializer.js';
import type {ExecutionGrantEnvelope} from '../../../lib/localExecutionRunner.js';

interface MaterializationRecord {
  id: string;
  approvalId: string;
  source: {vaultEntryId: string; credentialField: string};
  destinationPath: string;
  workspaceRoot: string;
  requestedMode: '0400' | '0600';
  expectedAbsence: boolean;
  expectedDestinationDigest: string | null;
  overwriteConsent: boolean;
  trackedFileException: boolean;
  plaintextDisclosureAcknowledged: boolean;
  purpose: string;
  requestNonce: string;
  runnerFingerprint: string;
  materializerDigest: string;
  status: string;
  destinationDigest: string | null;
  auditReference: string | null;
}

function assertMatchesLocal(
  record: MaterializationRecord,
  expected: Omit<
    MaterializationRecord,
    'id' | 'approvalId' | 'status' | 'destinationDigest' | 'auditReference'
  >,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(record[key as keyof MaterializationRecord]) !== JSON.stringify(value)) {
      throw new Error(`Materialization response changed approved field: ${key}`);
    }
  }
}

export default class VaultMaterializeRun extends BaseCommand {
  static description = 'Request approval, wait, and materialize one Vault field at the exact approved path';
  static flags = {
    ...BaseCommand.baseFlags,
    entry: Flags.string({required: true}),
    field: Flags.string({required: true}),
    destination: Flags.string({required: true}),
    workspace: Flags.string({required: true}),
    mode: Flags.string({options: ['0400', '0600'], default: '0600'}),
    purpose: Flags.string({required: true}),
    overwrite: Flags.boolean({default: false}),
    'tracked-exception': Flags.boolean({default: false}),
    'approval-timeout': Flags.integer({default: 600, min: 30, max: 600}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultMaterializeRun);
    const policyAllowsTrackedException =
      process.env.SIFT_ALLOW_TRACKED_SECRET_MATERIALIZATION === 'true';
    const precondition = await inspectMaterializationDestination({
      destinationPath: flags.destination,
      workspaceRoot: flags.workspace,
      trackedFileException: flags['tracked-exception'],
      policyAllowsTrackedException,
    });
    if (!precondition.expectedAbsence && !flags.overwrite) {
      throw new Error('Existing destination requires --overwrite and exact approved digest');
    }
    const runner = createMaterializerRunner();
    const nonce = randomBytes(32).toString('base64url');
    const local = {
      source: {vaultEntryId: flags.entry, credentialField: flags.field},
      destinationPath: flags.destination,
      workspaceRoot: flags.workspace,
      requestedMode: flags.mode as '0400' | '0600',
      expectedAbsence: precondition.expectedAbsence,
      expectedDestinationDigest: precondition.expectedDestinationDigest ?? null,
      overwriteConsent: !precondition.expectedAbsence && flags.overwrite,
      trackedFileException: flags['tracked-exception'],
      plaintextDisclosureAcknowledged: true,
      purpose: flags.purpose,
      requestNonce: nonce,
      runnerFingerprint: runner.fingerprint,
      materializerDigest: runner.materializerDigest,
    };
    const requested = await this.apiRequest<{
      materialization: MaterializationRecord;
      artifactEnvelope: ExecutionGrantEnvelope;
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
          expectedAbsence: precondition.expectedAbsence,
          expectedDestinationDigest: precondition.expectedDestinationDigest,
          overwriteConsent: !precondition.expectedAbsence && flags.overwrite,
          trackedFileException: flags['tracked-exception'],
          plaintextDisclosureAcknowledged: true,
          purpose: flags.purpose,
          requestNonce: nonce,
          runnerPublicKeyPem: runner.publicKeyPem,
          runnerPublicKeyFingerprint: runner.fingerprint,
          materializerDigest: runner.materializerDigest,
        },
      },
    );
    assertMatchesLocal(requested.materialization, local);
    const artifactBinding = createMaterializationArtifactBinding({
      materializationId: requested.materialization.id,
      runnerFingerprint: runner.fingerprint,
      materializerDigest: runner.materializerDigest,
      nonce,
    });
    if (requested.artifactBinding !== artifactBinding || !runner.privateKey) {
      throw new Error('Materialization artifact binding is invalid');
    }
    let artifact = decryptMaterializationEnvelope(
      requested.artifactEnvelope,
      runner.privateKey,
      artifactBinding,
      'vault_materialization_artifact',
      'artifact',
    );
    this.log(`Approval required: ${requested.materialization.approvalId}`);
    this.log(`Plaintext destination: ${flags.destination} (${flags.mode})`);
    this.log('Approve this exact destination-bound request in the first-party Siftable browser.');

    let plaintext = '';
    let redemptionCompleted = false;
    let localWriteCompleted = false;
    let cleanupSucceeded = false;
    try {
      const deadline = Date.now() + flags['approval-timeout'] * 1000;
      let approvalStatus = 'pending';
      while (Date.now() < deadline) {
        const approval = await this.apiRequest<{approval: {status: string}}>(
          flags,
          `/api/v1/governed-approvals/${encodeURIComponent(requested.materialization.approvalId)}?surface=cli`,
        );
        approvalStatus = approval.approval.status;
        if (approvalStatus === 'approved') break;
        if (approvalStatus !== 'pending') throw new Error(`Materialization approval is ${approvalStatus}`);
        await delay(2000);
      }
      if (approvalStatus !== 'approved') throw new Error('Materialization approval timed out');
      const redeemed = await this.apiRequest<{
        materialization: MaterializationRecord;
        envelope: ExecutionGrantEnvelope;
        binding: string;
      }>(
        flags,
        '/api/v1/vault/materializations/redeem',
        {
          method: 'POST',
          body: {
            surface: 'cli',
            artifact,
            approvalId: requested.materialization.approvalId,
            runnerFingerprint: runner.fingerprint,
            materializerDigest: runner.materializerDigest,
            requestNonce: nonce,
          },
        },
      );
      redemptionCompleted = true;
      assertMatchesLocal(redeemed.materialization, local);
      const credentialBinding = createMaterializationCredentialBinding({
        materializationId: requested.materialization.id,
        sourceEntry: flags.entry,
        sourceField: flags.field,
        runnerFingerprint: runner.fingerprint,
        materializerDigest: runner.materializerDigest,
        destinationPath: flags.destination,
        workspaceRoot: flags.workspace,
        mode: flags.mode as '0400' | '0600',
        expectedAbsence: precondition.expectedAbsence,
        expectedDestinationDigest: precondition.expectedDestinationDigest,
        trackedFileException: flags['tracked-exception'],
        purpose: flags.purpose,
        nonce,
      });
      if (redeemed.binding !== credentialBinding || !runner.privateKey) {
        throw new Error('Materialization credential binding is invalid');
      }
      plaintext = decryptMaterializationEnvelope(
        redeemed.envelope,
        runner.privateKey,
        credentialBinding,
        'vault_materialization_plaintext',
        'value',
      );
      const receipt: MaterializationReceipt = await materializeApprovedPlaintext({
        plaintext,
        destinationPath: flags.destination,
        workspaceRoot: flags.workspace,
        mode: flags.mode as '0400' | '0600',
        expectedAbsence: precondition.expectedAbsence,
        expectedDestinationDigest: precondition.expectedDestinationDigest,
        trackedFileException: flags['tracked-exception'],
        policyAllowsTrackedException,
        onCommitted: () => {
          localWriteCompleted = true;
        },
        onCleanup: succeeded => {
          cleanupSucceeded = succeeded;
        },
      });
      const completed = await this.apiRequest<{receipt: MaterializationRecord}>(
        flags,
        `/api/v1/vault/materializations/${encodeURIComponent(requested.materialization.id)}/complete`,
        {
          method: 'POST',
          body: {
            surface: 'cli',
            requestNonce: nonce,
            destinationDigest: receipt.destinationDigest,
            mode: receipt.mode,
            cleanupSucceeded: receipt.cleanupSucceeded,
          },
        },
      );
      if (!this.jsonEnabled()) {
        this.log(`Materialized: ${completed.receipt.id}`);
        this.log(`Destination digest: ${completed.receipt.destinationDigest}`);
        this.log(`Mode: ${completed.receipt.requestedMode}`);
        this.log(`Audit reference: ${completed.receipt.auditReference}`);
      }
      return completed.receipt;
    } catch (error) {
      if (redemptionCompleted) {
        try {
          await this.apiRequest(
            flags,
            `/api/v1/vault/materializations/${encodeURIComponent(requested.materialization.id)}/fail`,
            {
              method: 'POST',
              body: {
                surface: 'cli',
                requestNonce: nonce,
                failureCode: localWriteCompleted ? 'receipt_failed' : 'local_write_failed',
                cleanupSucceeded,
              },
            },
          );
        } catch {
          // Preserve the original local failure; the server still has the redeemed audit event.
        }
      }
      throw error;
    } finally {
      artifact = '';
      plaintext = '';
      runner.privateKey = null;
    }
  }
}
