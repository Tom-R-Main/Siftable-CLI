import {createHash, createPublicKey, verify} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {type EvidenceCall, type EvidenceSigner, evidenceStatement, evidenceStatementSignedPayload, PATCH_CONTENT_TYPE,
  uploadAgentLog} from './attemptEvidence.js';
import {generateMachineKey} from './machineProtocol.js';
import {ensureStateDirectory, writeKey} from './machineState.js';

let dir: string;
let signer: EvidenceSigner;
let publicKey: ReturnType<typeof createPublicKey>;
const IDS = {enrollmentId: '33333333-3333-4333-8333-333333333333', attemptId: '88888888-8888-4888-8888-888888888888',
  workItemId: '77777777-7777-4777-8777-777777777777', orgId: null};
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-evidence-'));
  const state = {root: path.join(dir, 'state'), owner: null};
  await ensureStateDirectory(state);
  const key = generateMachineKey();
  await writeKey(state, key.pem);
  publicKey = createPublicKey(key.privateKey);
  signer = {state, ...IDS};
});
afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}); });

describe('evidenceStatement', () => {
  it('signs canonical JSON with subjects in sha256 order (golden vector the server copy also asserts)', () => {
    const statement = evidenceStatement(IDS, [{kind: 'patch', sha256: 'b'.repeat(64), bytes: 8}, {kind: 'agent_log', sha256: 'a'.repeat(64), bytes: 3}]);
    const payload = evidenceStatementSignedPayload(statement);
    expect(payload.startsWith('{"attemptId":"88888888-8888-4888-8888-888888888888","context":"sift.attempt.evidence-statement.v1"')).toBe(true);
    expect(createHash('sha256').update(payload).digest('hex')).toBe('32e6960126bcf3a61bd0a6daa032dbb16a1490c783fdccef9c8557a057db9a88');
  });
});

describe('uploadAgentLog', () => {
  it('starts no upload or acknowledge once the deadline has passed, even within a round', async () => {
    const file = path.join(dir, 'agent.log');
    await fs.writeFile(file, 'log');
    let now = 0;
    const sent: string[] = [];
    // The declare itself takes the clock past the deadline.
    const call: EvidenceCall = async (_method, route) => {
      sent.push(route.endsWith('/acknowledge') ? 'ack' : 'declare');
      now = 20;
      return {status: 200, body: {manifestDigest: 'd'.repeat(64), acknowledgedAt: null, uploads: [{sha256: 'a'.repeat(64), url: 'https://storage.example/x'}]}};
    };
    const fetchImpl = (async () => { sent.push('put'); return new Response(null, {status: 200}); }) as unknown as typeof fetch;
    const outcome = await uploadAgentLog({call, fetch: fetchImpl, monoMs: () => now, deadlineMono: 10, route: '/r', claimToken: 'c',
      log: {path: file, sha256: 'a'.repeat(64), bytes: 3}, signer});
    expect(outcome).toEqual({acknowledged: false, manifestDigest: 'd'.repeat(64)});
    expect(sent).toEqual(['declare']);
  });

  it('counts a slow read of the log against the deadline, before anything is sent', async () => {
    let now = 0;
    const sent: string[] = [];
    const call: EvidenceCall = async () => { sent.push('declare'); return {status: 200, body: {}}; };
    const fetchImpl = (async () => { sent.push('put'); return new Response(null, {status: 200}); }) as unknown as typeof fetch;
    const outcome = await uploadAgentLog({call, fetch: fetchImpl, monoMs: () => now, deadlineMono: 10, route: '/r', claimToken: 'c',
      log: {path: 'unused', sha256: 'a'.repeat(64), bytes: 3}, read: async () => { now = 20; return Buffer.from('log'); }, signer});
    expect(outcome).toEqual({acknowledged: false});
    expect(sent).toEqual([]);
  });

  it('declares the patch beside the log and uploads each with its own type and exact length', async () => {
    const logFile = path.join(dir, 'agent.log');
    const patchFile = path.join(dir, 'sift.patch');
    await fs.writeFile(logFile, 'log');
    await fs.writeFile(patchFile, '# patch\n');
    const declared: unknown[] = [];
    const acks: Array<{statement: Record<string, unknown>; signature: string}> = [];
    const puts: Array<{type: string; range: string; body: string}> = [];
    const call: EvidenceCall = async (_method, route, body) => {
      if (route.endsWith('/acknowledge')) {
        acks.push(body as {statement: Record<string, unknown>; signature: string});
        return {status: 200, body: {acknowledgedAt: 'now'}};
      }
      declared.push((body as {artifacts: unknown}).artifacts);
      return {status: 200, body: {manifestDigest: 'd'.repeat(64), acknowledgedAt: null, uploads: [
        {sha256: 'b'.repeat(64), url: 'https://storage.example/patch'}, {sha256: 'a'.repeat(64), url: 'https://storage.example/log'}]}};
    };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      puts.push({type: headers['Content-Type'], range: headers['x-goog-content-length-range'], body: String(init.body)});
      return new Response(null, {status: 200});
    }) as unknown as typeof fetch;
    const outcome = await uploadAgentLog({call, fetch: fetchImpl, monoMs: () => 0, deadlineMono: 10_000, route: '/r', claimToken: 'c',
      log: {path: logFile, sha256: 'a'.repeat(64), bytes: 3},
      also: [{kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: patchFile, sha256: 'b'.repeat(64), bytes: 8}], signer});
    expect(outcome).toEqual({acknowledged: true, manifestDigest: 'd'.repeat(64)});
    // The acknowledgement carries the statement over both files, signed with the enrollment key.
    expect(acks).toHaveLength(1);
    expect(acks[0].statement).toEqual({context: 'sift.attempt.evidence-statement.v1', version: 1, ...IDS,
      subjects: [{kind: 'agent_log', sha256: 'a'.repeat(64), bytes: 3}, {kind: 'patch', sha256: 'b'.repeat(64), bytes: 8}]});
    expect(verify(null, Buffer.from(evidenceStatementSignedPayload(acks[0].statement)), publicKey,
      Buffer.from(acks[0].signature, 'base64url'))).toBe(true);
    expect(declared[0]).toEqual([{kind: 'agent_log', sha256: 'a'.repeat(64), bytes: 3, contentType: 'text/plain'},
      {kind: 'patch', sha256: 'b'.repeat(64), bytes: 8, contentType: PATCH_CONTENT_TYPE}]);
    expect(puts).toEqual([{type: PATCH_CONTENT_TYPE, range: '8,8', body: '# patch\n'}, {type: 'text/plain', range: '3,3', body: 'log'}]);
  });

  it('declares nothing when two files share a digest, since the manifest would be refused', async () => {
    const file = path.join(dir, 'agent.log');
    await fs.writeFile(file, 'same');
    const sent: string[] = [];
    const call: EvidenceCall = async () => { sent.push('declare'); return {status: 200, body: {}}; };
    const outcome = await uploadAgentLog({call, fetch: (async () => new Response(null)) as unknown as typeof fetch, monoMs: () => 0,
      deadlineMono: 10_000, route: '/r', claimToken: 'c', log: {path: file, sha256: 'a'.repeat(64), bytes: 4},
      also: [{kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: file, sha256: 'a'.repeat(64), bytes: 4}], signer});
    expect(outcome).toEqual({acknowledged: false});
    expect(sent).toEqual([]);
  });

  it('sends nothing without the enrollment key, and stops at a refused acknowledgement', async () => {
    const file = path.join(dir, 'agent.log');
    await fs.writeFile(file, 'log');
    const sent: string[] = [];
    const call: EvidenceCall = async (_method, route) => {
      sent.push(route.endsWith('/acknowledge') ? 'ack' : 'declare');
      return route.endsWith('/acknowledge') ? {status: 422, body: {}}
        : {status: 200, body: {manifestDigest: 'd'.repeat(64), acknowledgedAt: null, uploads: []}};
    };
    const fetchImpl = (async () => new Response(null, {status: 200})) as unknown as typeof fetch;
    const upload = (with_: EvidenceSigner) => uploadAgentLog({call, fetch: fetchImpl, monoMs: () => 0, deadlineMono: 10_000, route: '/r',
      claimToken: 'c', log: {path: file, sha256: 'a'.repeat(64), bytes: 3}, signer: with_});
    await expect(upload({...signer, state: {root: path.join(dir, 'no-state'), owner: null}})).resolves.toEqual({acknowledged: false});
    expect(sent).toEqual([]);
    // 422: the server refused the evidence itself; another round would be refused the same way.
    await expect(upload(signer)).resolves.toEqual({acknowledged: false, manifestDigest: 'd'.repeat(64)});
    expect(sent).toEqual(['declare', 'ack']);
  });
});
