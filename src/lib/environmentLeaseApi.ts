import type {
  EnvironmentLeaseArtifactPathClass,
  EnvironmentLeaseCleanupState,
} from './environmentLease.js';

export interface EnvironmentLeaseApiRecord {
  contractVersion: 1;
  id: string;
  owner: string;
  bundleDigest: string;
  memberNames: string[];
  endpointClass: 'development' | 'production' | 'ci' | 'shared_host';
  consumer: string;
  holder: string;
  purpose: string;
  authorizationId: string | null;
  authorizationExpiresAt: string;
  expiresAt: string;
  artifactPathClass: EnvironmentLeaseArtifactPathClass;
  materializerDigest: string;
  runnerFingerprint: string;
  endpointEnrollment: {
    id: string;
    classification: 'interactive_desktop' | 'remote_vm' | 'noninteractive_runner' | 'shared_host' | 'ci_runner' | 'production_host' | 'multi_tenant';
    storageTier: 'hardware_host_bound' | 'systemd_managed' | 'convenience_keyring' | 'none';
    dedicated: boolean;
    policyEligible: boolean;
    killSwitchEnabled: boolean;
  };
  lifecycle: string;
  cleanup: {
    contractVersion: 1;
    state: EnvironmentLeaseCleanupState;
    reason: string | null;
    attemptId: string | null;
    attemptedAt: string | null;
    completedAt: string | null;
  };
  createdAt: string;
}

export function projectEnvironmentLeaseMetadata(record: EnvironmentLeaseApiRecord) {
  return {
    id: record.id,
    owner: record.owner,
    bundleDigest: record.bundleDigest,
    memberNames: record.memberNames,
    endpointClass: record.endpointClass,
    consumer: record.consumer,
    holder: record.holder,
    purpose: record.purpose,
    authorizationId: record.authorizationId,
    authorizationExpiresAt: record.authorizationExpiresAt,
    expiresAt: record.expiresAt,
    artifactPathClass: record.artifactPathClass,
    materializerDigest: record.materializerDigest,
    runnerFingerprint: record.runnerFingerprint,
    endpointEnrollment: record.endpointEnrollment,
    lifecycle: record.lifecycle,
    cleanup: record.cleanup,
    createdAt: record.createdAt,
  };
}
