import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {type EvidenceCall, uploadAgentLog} from './attemptEvidence.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-evidence-')); });
afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}); });

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
      log: {path: file, sha256: 'a'.repeat(64), bytes: 3}});
    expect(outcome).toEqual({acknowledged: false, manifestDigest: 'd'.repeat(64)});
    expect(sent).toEqual(['declare']);
  });

  it('counts a slow read of the log against the deadline, before anything is sent', async () => {
    let now = 0;
    const sent: string[] = [];
    const call: EvidenceCall = async () => { sent.push('declare'); return {status: 200, body: {}}; };
    const fetchImpl = (async () => { sent.push('put'); return new Response(null, {status: 200}); }) as unknown as typeof fetch;
    const outcome = await uploadAgentLog({call, fetch: fetchImpl, monoMs: () => now, deadlineMono: 10, route: '/r', claimToken: 'c',
      log: {path: 'unused', sha256: 'a'.repeat(64), bytes: 3}, read: async () => { now = 20; return Buffer.from('log'); }});
    expect(outcome).toEqual({acknowledged: false});
    expect(sent).toEqual([]);
  });
});
