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
  /\/Users\//,
  /\/home\//,
];

describe('VAULT-AX-01 evidence contract', () => {
  it('maps each acceptance criterion exactly once through the redacted schema', () => {
    const result = new Validator(schema).validate(evidence);
    expect(result.valid).toBe(true);
    expect(evidence.criteria.map((criterion: {criterion: number}) => criterion.criterion))
      .toEqual(Array.from({length: 13}, (_, index) => index + 1));
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
      rfc7638Thumbprint: false,
      hostMetadataIsIdentity: false,
      callerDeclaredSurfaceIsAuthority: false,
    });
  });

  it('pins the stacked base, complete command surface, and failed MCP preflight', () => {
    expect(evidence.base).toEqual({
      commit: '4ee9ad1f1917c853a728961af3659a238d9d3792',
      pullRequest: 139,
      stateAtStart: 'open',
      requiresPostMergeReverification: true,
    });
    expect(evidence.preflight.environmentCommands).toEqual([
      'check', 'diff', 'example', 'import apply', 'import plan', 'pull', 'rm', 'status',
    ]);
    expect(evidence.preflight.mcpRedeemBoundary).toEqual({
      status: 'failed',
      reason: 'request surface is caller supplied and is not bound to authentication provenance',
    });
  });
});
