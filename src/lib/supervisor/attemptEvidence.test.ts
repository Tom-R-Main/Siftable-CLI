import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {type EvidenceCall, PATCH_CONTENT_TYPE, uploadAgentLog} from './attemptEvidence.js';

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

  it('declares the patch beside the log and uploads each with its own type and exact length', async () => {
    const logFile = path.join(dir, 'agent.log');
    const patchFile = path.join(dir, 'sift.patch');
    await fs.writeFile(logFile, 'log');
    await fs.writeFile(patchFile, '# patch\n');
    const declared: unknown[] = [];
    const puts: Array<{type: string; range: string; body: string}> = [];
    const call: EvidenceCall = async (_method, route, body) => {
      if (route.endsWith('/acknowledge')) return {status: 200, body: {acknowledgedAt: 'now'}};
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
      also: [{kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: patchFile, sha256: 'b'.repeat(64), bytes: 8}]});
    expect(outcome).toEqual({acknowledged: true, manifestDigest: 'd'.repeat(64)});
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
      also: [{kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: file, sha256: 'a'.repeat(64), bytes: 4}]});
    expect(outcome).toEqual({acknowledged: false});
    expect(sent).toEqual([]);
  });
});
