import {createPublicKey, verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {evidenceStatementSignedPayload} from './attemptEvidence.js';
import {cleanupReceiptSignedPayload} from './cleanupReceiptOutbox.js';
import {machineCanonicalJson, machineQualificationSignedPayload} from './qualificationProtocol.js';

// The supervisor's own copies of the signed-payload encoders must reproduce the
// server's golden vectors byte for byte (mvp-managed-agent-work.md section 6).
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../docs/architecture/signing-golden-vectors.json'), 'utf8'));

describe('supervisor signing golden vectors', () => {
  it('canonicalize every vector exactly as the server does', () => {
    for (const vector of fixture.canonical) {
      expect(machineCanonicalJson(JSON.parse(vector.inputJson)), vector.name).toBe(vector.canonical);
    }
  });

  it('produce the exact signed payloads, and the published signatures verify over them', () => {
    const publicKey = createPublicKey({key: Buffer.from(fixture.key.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki'});
    const encoders: Record<string, (input: any) => string> = {
      qualification: ({binding, nonce, resultDigest}) => machineQualificationSignedPayload(binding, nonce, resultDigest),
      cleanupReceipt: (input) => cleanupReceiptSignedPayload(input),
      evidenceStatement: (input) => evidenceStatementSignedPayload(input),
    };
    expect(fixture.payloads.map((vector: {kind: string}) => vector.kind).sort()).toEqual(Object.keys(encoders).sort());
    for (const vector of fixture.payloads) {
      const payload = encoders[vector.kind](vector.input);
      expect(payload, vector.name).toBe(vector.payload);
      expect(verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(vector.signatureBase64url, 'base64url'))).toBe(true);
    }
  });
});
