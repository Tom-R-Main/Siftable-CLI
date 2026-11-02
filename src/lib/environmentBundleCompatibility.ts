import {createHash} from 'node:crypto';

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

export function createMaterializationRedemptionProofBinding(input: {
  artifact: string;
  approvalId: string;
  runnerFingerprint: string;
  materializerDigest: string;
  requestNonce: string;
  runnerProofTimestamp: string;
}): string {
  return canonicalJson({
    approvalId: input.approvalId,
    artifactDigest: createHash('sha256').update(input.artifact).digest('hex'),
    materializerDigest: input.materializerDigest,
    proofContext: 'sift.vault.materialization.redeem.v1',
    requestNonce: input.requestNonce,
    runnerProofTimestamp: input.runnerProofTimestamp,
    runnerPublicKeyFingerprint: input.runnerFingerprint,
  });
}
