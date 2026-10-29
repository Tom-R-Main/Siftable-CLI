import {createHash, createPublicKey, verify} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  cleanupReceiptSignedPayload,
  enqueueReceipts,
  flushReceipts,
  OUTBOX,
  pendingReceipts,
  receiptsForStop,
} from './cleanupReceiptOutbox.js';
import {generateMachineKey} from './machineProtocol.js';
import {ensureStateDirectory, readJournal, writeKey} from './machineState.js';

const ATTEMPT = {attemptId: '88888888-8888-4888-8888-888888888888', workItemId: '77777777-7777-4777-8777-777777777777',
  dispatchId: '66666666-6666-4666-8666-666666666666', orgId: null};
const ENROLLMENT = '33333333-3333-4333-8333-333333333333';

describe('cleanup receipt protocol (CLI copy)', () => {
  it('signs the same bytes as the server for the golden vector', () => {
    const payload = cleanupReceiptSignedPayload({...ATTEMPT, enrollmentId: ENROLLMENT, state: 'cleaned', reason: null,
      containersRemoved: 2, recoveryVolumeRetained: false, operationKey: `${ATTEMPT.attemptId}:cleaned:1`, signedAt: '2026-10-29T08:00:00.000Z'});
    expect(createHash('sha256').update(payload).digest('hex')).toBe('7849f253ce0fd61f9eefbac0d9dc44197a21b91a6c50cc0b93fdf2d7717ebaca');
  });
});

describe('receiptsForStop', () => {
  it('reports a stop then its cleanup, with keys that never repeat', () => {
    const clean = receiptsForStop(ATTEMPT, {cgroupEmpty: 'empty', resourcesRemoved: true, held: [], containersRemoved: 2}, []);
    expect(clean.map((r) => [r.state, r.operationKey, r.containersRemoved])).toEqual([
      ['execution_stopped', `${ATTEMPT.attemptId}:execution_stopped:1`, 0], ['cleaned', `${ATTEMPT.attemptId}:cleaned:1`, 2]]);
    const held = receiptsForStop(ATTEMPT, {cgroupEmpty: 'empty', resourcesRemoved: false, held: ['container:abc'], containersRemoved: 1}, []);
    expect(held.map((r) => [r.state, r.reason])).toEqual([['execution_stopped', null], ['cleanup_failed', 'container:abc']]);
    // A later observation after a held stop: a new key, and no second execution_stopped.
    const queued = held.map((facts) => ({enrollmentId: ENROLLMENT, facts, status: 'accepted' as const, sends: 1}));
    expect(receiptsForStop(ATTEMPT, {cgroupEmpty: 'empty', resourcesRemoved: true, held: [], containersRemoved: 1}, queued)
      .map((r) => r.operationKey)).toEqual([`${ATTEMPT.attemptId}:cleaned:1`]);
  });

  it('never claims a stop it did not observe', () => {
    expect(receiptsForStop(ATTEMPT, {cgroupEmpty: 'populated', resourcesRemoved: false, held: [], containersRemoved: 0}, [])
      .map((r) => [r.state, r.reason])).toEqual([['cleanup_failed', 'cgroup populated']]);
  });
});

describe('outbox', () => {
  let root: string;
  let key: ReturnType<typeof generateMachineKey>;
  beforeEach(async () => {
    root = path.join(await fs.mkdtemp(path.join(tmpdir(), 'sift-outbox-')), 'state');
    await ensureStateDirectory({root, owner: null});
    key = generateMachineKey();
    await writeKey({root, owner: null}, key.pem);
  });
  afterEach(async () => fs.rm(path.dirname(root), {recursive: true, force: true}));

  function server(replies: Array<number | 'throw' | {status: number; body: object}>) {
    const sent: Array<{receipt: Record<string, unknown>; signature: string; url: string}> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {receipt: Record<string, unknown>; signature: string};
      sent.push({...body, url});
      const reply = replies.shift() ?? 201;
      if (reply === 'throw') throw new TypeError('fetch failed');
      const {status, body: payload} = typeof reply === 'number' ? {status: reply, body: {}} : reply;
      return new Response(JSON.stringify(payload), {status});
    }) as unknown as typeof fetch;
    return {sent, fetchImpl};
  }
  const flush = (fetchImpl: typeof fetch, at = '2026-10-29T08:00:00.000Z') =>
    flushReceipts({fetch: fetchImpl, state: {root, owner: null}, apiUrl: 'https://api.example', now: () => new Date(at), workspaceId: null});

  it('sends each receipt signed now, keeps unknown answers pending, and re-sends the same facts under the same key', async () => {
    await enqueueReceipts({root, owner: null}, ENROLLMENT,
      receiptsForStop(ATTEMPT, {cgroupEmpty: 'empty', resourcesRemoved: true, held: [], containersRemoved: 2}, []));
    const first = server(['throw', 429]);
    expect(await flush(first.fetchImpl)).toEqual({sent: 2, pending: 2});
    expect(first.sent[0].url).toBe(`https://api.example/api/v1/machines/enrollments/${ENROLLMENT}/cleanup-receipts`);
    const publicKey = createPublicKey(key.privateKey);
    expect(verify(null, Buffer.from(cleanupReceiptSignedPayload(first.sent[0].receipt as never)), publicKey,
      Buffer.from(first.sent[0].signature, 'base64url'))).toBe(true);
    const second = server([201, 200]);
    expect(await flush(second.fetchImpl, '2026-10-29T08:30:00.000Z')).toEqual({sent: 2, pending: 0});
    expect(second.sent[0].receipt.operationKey).toBe(first.sent[0].receipt.operationKey);
    expect(second.sent[0].receipt.signedAt).toBe('2026-10-29T08:30:00.000Z');
    expect(await pendingReceipts({root, owner: null})).toEqual([]);
  });

  it('keeps a live-claim refusal pending, ends a fact conflict, and refuses malformed or unbound receipts', async () => {
    await enqueueReceipts({root, owner: null}, ENROLLMENT, [
      ...receiptsForStop(ATTEMPT, {cgroupEmpty: 'empty', resourcesRemoved: true, held: [], containersRemoved: 2}, []),
      ...receiptsForStop({...ATTEMPT, attemptId: '99999999-9999-4999-8999-999999999999'},
        {cgroupEmpty: 'unknown', resourcesRemoved: false, held: [], containersRemoved: 0}, []),
    ]);
    const answers = server([
      {status: 409, body: {message: 'The dispatch still holds a live claim; report cleanup with it'}},
      {status: 409, body: {message: 'A different receipt was already recorded under this operation key'}},
      403,
    ]);
    await flush(answers.fetchImpl);
    const outbox = await readJournal<{entries: Array<{status: string}>}>({root, owner: null}, OUTBOX);
    expect(outbox?.entries.map((entry) => entry.status)).toEqual(['pending', 'conflict', 'refused']);
  });

  it('never queues the same key twice, and sends at most ten a cycle, oldest first', async () => {
    const many = Array.from({length: 12}, (_, i) => ({...ATTEMPT, state: 'cleaned' as const, reason: null, containersRemoved: 1,
      recoveryVolumeRetained: false, operationKey: `${ATTEMPT.attemptId}:cleaned:${i + 1}`}));
    await enqueueReceipts({root, owner: null}, ENROLLMENT, many);
    await enqueueReceipts({root, owner: null}, ENROLLMENT, many.slice(0, 3));
    expect(await pendingReceipts({root, owner: null})).toHaveLength(12);
    const answers = server([]);
    expect(await flush(answers.fetchImpl)).toEqual({sent: 10, pending: 2});
    expect(answers.sent[0].receipt.operationKey).toBe(`${ATTEMPT.attemptId}:cleaned:1`);
  });
});
