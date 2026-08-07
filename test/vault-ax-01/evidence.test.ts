import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Validator} from '@cfworker/json-schema';
import {describe, expect, it} from 'vitest';

const fixtureDirectory = path.resolve(import.meta.dirname);
const evidence = JSON.parse(readFileSync(path.join(fixtureDirectory, 'evidence.json'), 'utf8'));
const schema = JSON.parse(readFileSync(path.join(fixtureDirectory, 'evidence.schema.json'), 'utf8'));

const forbiddenEvidence = [
  /sift_pat_/i,
  /exf_pat_/i,
  /bearer\s+[a-z0-9._-]+/i,
  /ciphertext/i,
  /private.?key/i,
  /fixture.?value/i,
  /\/(?:Users|home|var|etc|tmp|private)\//,
  /~\/(?:\.config|\.local|\.ssh)\//,
  /[A-Za-z]:\\Users\\/,
  /(?:^|["'])\.\.\//,
];

describe('VAULT-AX-01 evidence contract', () => {
  it('maps each acceptance criterion exactly once through the redacted schema', () => {
    const result = new Validator(schema).validate(evidence);
    expect(result.valid).toBe(true);
    expect(evidence.criteria.map((criterion: {criterion: number}) => criterion.criterion))
      .toEqual(Array.from({length: 13}, (_, index) => index + 1));
    expect(evidence.criteria.map((criterion: {slug: string}) => criterion.slug)).toEqual([
      'complete-trajectory',
      'cli-compatibility',
      'cross-client-discovery',
      'mcp-redemption-boundary',
      'request-storm-dedupe',
      'changed-field-set-refusal',
      'no-secret-output',
      'workspace-integrity-and-state',
      'approval-to-removal-e2e',
      'actionable-failure-recovery',
      'ai-gateway-separation',
      'evidence-bundle',
      'focused-tests',
    ]);
  });

  it('contains no credential shapes, plaintext markers, or absolute auth paths', () => {
    const serialized = JSON.stringify(evidence);
    for (const forbidden of forbiddenEvidence) {
      expect(serialized).not.toMatch(forbidden);
    }
  });

  it('records identity as possession proof rather than host detection', () => {
    expect(evidence.securityBoundary).toMatchObject({
      endpointIdentifier: 'sha256-canonical-spki',
      possessionProof: 'rsa-pss-domain-separated-request',
      redemptionAuthority: 'runner-encrypted-artifact-plus-server-route',
      rfc7638Thumbprint: false,
      hostMetadataIsIdentity: false,
      callerDeclaredSurfaceIsAuthority: false,
    });
  });

  it('pins the merged base, complete command surface, and passed MCP boundary', () => {
    expect(evidence.base).toEqual({
      commit: 'c0765f27993abc8e80f8ca30c2a5b2f82a713fc8',
      pullRequest: 139,
      stateAtStart: 'merged',
      requiresPostMergeReverification: false,
    });
    expect(evidence.preflight.environmentCommands).toEqual([
      'check', 'diff', 'example', 'import apply', 'import plan', 'pull', 'rm', 'status',
    ]);
    expect(evidence.preflight.previousCli).toEqual({
      version: '0.5.37',
      result: 'upgrade_before_state',
      command: 'npm install -g @siftable/cli@latest',
    });
    expect(evidence.preflight.mcpRedeemBoundary.status).toBe('passed');
  });

  it('records the real request-storm result and the unrelated baseline diagnostic separately', () => {
    expect(evidence.criteria.every((criterion: {disposition: string}) => (
      criterion.disposition === 'passed'
    ))).toBe(true);
    const concurrency = evidence.verificationRuns.find(
      (run: {id: string}) => run.id === 'runtime-role-concurrency',
    );
    expect(concurrency).toMatchObject({
      result: 'passed',
      metrics: {
        requests: 50,
        approvals: 1,
        notifications: 1,
        inAppDeliveries: 1,
        supersedeAudits: 49,
        revoked: 49,
      },
    });
    const typecheck = evidence.verificationRuns.find(
      (run: {id: string}) => run.id === 'workspace-typecheck',
    );
    expect(typecheck).toMatchObject({
      result: 'baseline_failed',
      metrics: {unrelatedDiagnostics: 2},
    });
  });
});
