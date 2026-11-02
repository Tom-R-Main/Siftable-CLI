import {createPublicKey, verify} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  hostedChallengeRequestPayload,
  hostedEnroll,
  hostedEnrollmentPayload,
  hostedKeygen,
  readInstanceIdentity,
} from './hostedEnroll.js';
import {MachineEnrollError} from './machineEnroll.js';
import {inspectMachineState, type MachineStateOptions, readCredentialRecord, writeCredentialRecord} from './machineState.js';

const API = 'https://api.example';
const HOSTED = '11111111-2222-4333-8444-555555555555';
const RUNNER = '22222222-3333-4444-8555-666666666666';
const ENROLLMENT = '33333333-4444-4555-8666-777777777777';
const ORG = '44444444-5555-4666-8777-888888888888';
const identity = {document: '{\n  "instanceId" : "i-0123456789abcdef0"\n}', signature: 'c2lnbmF0dXJl\n'};

let state: MachineStateOptions;
beforeEach(async () => {
  state = {root: await fs.mkdtemp(path.join(tmpdir(), 'hosted-enroll-')), owner: null};
});
afterEach(async () => {
  await fs.rm(state.root, {recursive: true, force: true});
});

const verifies = (publicKey: string, payload: string, signature: string) => verify(null, Buffer.from(payload),
  createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki'}),
  Buffer.from(signature, 'base64url'));

/** A server that checks both signatures and replies with the given generation, or refuses. */
function server(options: {generation: number; refuse?: boolean}) {
  const seen: Array<{url: string; body?: Record<string, unknown>}> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    expect(init.redirect).toBe('error');
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    seen.push({url: target, body});
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {status});
    if (target === `${API}/auth/device/machine/hosted/challenge`) {
      const b = body as {hostedMachineId: string; publicKey: string; issuedAt: string; signature: string};
      const fingerprint = (await import('./machineProtocol.js')).machineKeyFingerprint(b.publicKey);
      expect(verifies(b.publicKey, hostedChallengeRequestPayload({hostedMachineId: b.hostedMachineId, fingerprint, issuedAt: b.issuedAt}), b.signature)).toBe(true);
      return json(201, {nonce: 'n'.repeat(43), credentialGeneration: options.generation - 1, runnerId: RUNNER, expiresAt: 'later'});
    }
    if (target === `${API}/auth/device/machine/hosted`) {
      if (options.refuse) return json(403, {error: 'refused'});
      const b = body as {hostedMachineId: string; publicKey: string; nonce: string; credentialGeneration: number; signature: string; identityDocument: string};
      const fingerprint = (await import('./machineProtocol.js')).machineKeyFingerprint(b.publicKey);
      expect(verifies(b.publicKey, hostedEnrollmentPayload({hostedMachineId: b.hostedMachineId, runnerId: RUNNER, fingerprint, nonce: b.nonce,
        credentialGeneration: b.credentialGeneration}), b.signature)).toBe(true);
      // The document's bytes go up exactly as IMDS served them.
      expect(b.identityDocument).toBe(identity.document);
      return json(200, {access_token: `token-${options.generation}`, token_type: 'Bearer', credential_generation: options.generation,
        machine: {enrollmentId: ENROLLMENT, runnerId: RUNNER, publicKeyFingerprint: fingerprint, orgId: ORG}});
    }
    if (target === `${API}/api/v1/machines/enrollments/${ENROLLMENT}`) {
      const machine = await inspectMachineState(state);
      const fingerprint = machine.kind === 'enrolled' ? machine.machine.fingerprint : '';
      return json(200, {enrollmentId: ENROLLMENT, runnerId: RUNNER, keyFingerprint: fingerprint, credentialId: 'cred-1', qualifiedAt: null});
    }
    throw new Error(`unexpected ${target}`);
  }) as typeof fetch;
  return {fetchImpl, seen};
}

const deps = (fetchImpl: typeof fetch) => ({fetch: fetchImpl, state, now: () => new Date('2026-11-01T08:00:00.000Z'), identity: async () => identity});

describe('hosted machine enrollment (CLI)', () => {
  it('signs the same literal payloads the server checks', () => {
    expect(hostedChallengeRequestPayload({hostedMachineId: 'h', fingerprint: 'f', issuedAt: 't'}))
      .toBe('{"context":"sift.machine.hosted.challenge.v1","hostedMachineId":"h","fingerprint":"f","issuedAt":"t"}');
    expect(hostedEnrollmentPayload({hostedMachineId: 'h', runnerId: 'r', fingerprint: 'f', nonce: 'n', credentialGeneration: 3}))
      .toBe('{"context":"sift.machine.hosted.enrollment.v1","hostedMachineId":"h","runnerId":"r","fingerprint":"f","nonce":"n","credentialGeneration":3}');
  });

  it('creates the key once and prints the same public key on a resend', async () => {
    const first = await hostedKeygen(state, HOSTED);
    const again = await hostedKeygen(state, HOSTED);
    expect(again).toEqual(first);
    const stat = await fs.stat(path.join(state.root, 'enrollment-key.pem'));
    expect(stat.mode & 0o777).toBe(0o600);
    await expect(hostedKeygen(state, 'not-an-id')).rejects.toThrow(MachineEnrollError);
  });

  it('enrolls, saves the credential with its generation, and records the hosted machine', async () => {
    await hostedKeygen(state, HOSTED);
    const {fetchImpl} = server({generation: 1});
    const result = await hostedEnroll(deps(fetchImpl), {apiUrl: API, hostedMachineId: HOSTED});
    expect(result).toMatchObject({enrollmentId: ENROLLMENT, runnerId: RUNNER, credentialGeneration: 1, saved: true});
    expect(await readCredentialRecord(state)).toEqual({token: 'token-1', generation: 1});
    const machine = await inspectMachineState(state);
    expect(machine).toMatchObject({kind: 'enrolled', machine: {hostedMachineId: HOSTED, runnerId: RUNNER, scope: {type: 'workspace', id: ORG}, credentialId: 'cred-1'}});
  });

  it('never saves an older credential over a newer one', async () => {
    await hostedKeygen(state, HOSTED);
    await hostedEnroll(deps(server({generation: 3}).fetchImpl), {apiUrl: API, hostedMachineId: HOSTED});
    const late = await hostedEnroll(deps(server({generation: 2}).fetchImpl), {apiUrl: API, hostedMachineId: HOSTED});
    expect(late).toMatchObject({saved: false, credentialGeneration: 3});
    expect(await readCredentialRecord(state)).toEqual({token: 'token-3', generation: 3});
  });

  it('saves nothing when the server refuses, and needs the key first', async () => {
    await expect(hostedEnroll(deps(server({generation: 1}).fetchImpl), {apiUrl: API, hostedMachineId: HOSTED})).rejects.toThrow(/keygen --hosted first/);
    await hostedKeygen(state, HOSTED);
    await writeCredentialRecord(state, {token: 'old', generation: 1});
    await expect(hostedEnroll(deps(server({generation: 2, refuse: true}).fetchImpl), {apiUrl: API, hostedMachineId: HOSTED}))
      .rejects.toThrow(/refused this machine/);
    expect(await readCredentialRecord(state)).toEqual({token: 'old', generation: 1});
  });

  it('reads the identity document over IMDSv2, token first, keeping its bytes', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push(`${init.method} ${String(url)}`);
      if (String(url).endsWith('/latest/api/token')) return new Response('imds-token');
      expect(init.headers).toEqual({'X-aws-ec2-metadata-token': 'imds-token'});
      return new Response(String(url).endsWith('/document') ? identity.document : identity.signature);
    }) as typeof fetch;
    expect(await readInstanceIdentity(fetchImpl)).toEqual(identity);
    expect(calls).toEqual([
      'PUT http://169.254.169.254/latest/api/token',
      'GET http://169.254.169.254/latest/dynamic/instance-identity/document',
      'GET http://169.254.169.254/latest/dynamic/instance-identity/signature',
    ]);
  });
});
