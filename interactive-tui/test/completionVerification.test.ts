import {expect, test} from 'bun:test';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {defineTool, ok} from '../agent-harness/framework/tool';
import {InMemorySessionEventStore, SessionKernel, type SessionEventStore} from '../agent-harness/framework/session';
import type {ChatAgentChatOptions} from '../agent-harness/framework/chat-agent-types';
import type {AdapterResponse, ChatMessage} from '../agent-harness/framework/adapters/types';
import type {CandidateVerificationReceipt} from '../candidateVerification';

type Check = NonNullable<ChatAgentChatOptions['completionVerification']>;
async function fixture(run: (root: string, check: Check) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-completion-check-')));
  await writeFile(join(root, 'candidate.txt'), 'broken');
  const check: Check = {argv: ['/bin/sh', '-c', '[ "$(cat candidate.txt)" = repaired ] || { printf "candidate is broken"; exit 1; }'], files: ['candidate.txt'],
    context: {workspaceRoot: root, sessionCwd: root, deadline: Date.now() + 10_000, approval: {policy: 'allow', scopeId: 'explicit-check'}}};
  try {await run(root, check);} finally {await rm(root, {recursive: true, force: true});}
}
async function create(root: string, responses: AdapterResponse[], options: {store?: SessionEventStore; maxRounds?: number; onRequest?: () => void} = {}) {
  const requests: ChatMessage[][] = [], signals: Array<AbortSignal | undefined> = [];
  const agent = await createChatAgent({memory: false, maxToolRounds: options.maxRounds ?? 4,
    session: {id: 'completion-check', store: options.store}, executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    tools: [defineTool({name: 'repair', description: 'Repair fixture', inputSchema: {type: 'object', properties: {}}, handler: async () => {
      await writeFile(join(root, 'candidate.txt'), 'repaired'); return ok('repaired');
    }})],
    adapter: {name: 'fixture', model: 'fixture', chat: async (history, _registry, opts) => {
      requests.push(structuredClone(history)); signals.push(opts?.signal); options.onRequest?.();
      const response = responses.shift(); if (!response) throw new Error('Unexpected extra model request'); return response;
    }},
  });
  return {agent, requests, signals};
}

test('failed check repairs in the same context, turn and round allowance', async () => fixture(async (root, check) => {
  const f = await create(root, [{text: 'Tentatively finished.'}, {toolCall: {id: 'repair-1', name: 'repair', args: {}}}, {text: 'Repaired and checked.'}]);
  const signal = new AbortController().signal, receipts: CandidateVerificationReceipt[] = [];
  try {
    const result = await f.agent.chat('Repair this candidate', {signal, completionVerification: check, onVerification: receipt => receipts.push(receipt)});
    expect(result).toMatchObject({text: 'Repaired and checked.', rounds: 3, run: {status: 'completed'}, verification: {status: 'passed'}});
    expect(f.signals.every(value => value === signal)).toBe(true);
    expect(f.requests[1]!.at(-1)?.content).toContain('candidate is broken');
    expect(f.requests[2]!.some(message => message.role === 'tool')).toBe(true);
    const events = f.agent.getSessionEvents(), checks = events.filter(event => event.type === 'verification/recorded');
    expect(events.filter(event => event.type === 'turn/started')).toHaveLength(1);
    expect(checks.map(event => event.data.receipt.status)).toEqual(['failed', 'passed']);
    expect(checks.every(event => event.data.receipt.turnId === result.run.manifest.runId)).toBe(true);
    expect(checks[0]!.data.receipt.before!.sha256).not.toBe(checks[1]!.data.receipt.before!.sha256);
    expect(receipts.map(receipt => receipt.status)).toEqual(['unknown', 'failed', 'unknown', 'passed']);
    const replay = new SessionKernel({sessionId: 'completion-check', store: {read: () => events, append: () => {throw new Error('read-only');}}});
    expect(replay.getHistory()).toEqual(f.agent.getHistory());
  } finally {await f.agent.close();}
}));

test('snapshots mutable check inputs before the first model request; last failed check hits the limit', async () => fixture(async (root, check) => {
  const original = [...check.argv];
  const f = await create(root, [{text: 'done'}], {maxRounds: 1, onRequest: () => {
    check.argv = ['/bin/sh', '-c', 'printf changed > marker.txt']; check.files = ['marker.txt'];
    check.context = {...check.context, deadline: 0, approval: {policy: 'deny', scopeId: 'changed'}};
  }});
  try {
    const result = await f.agent.chat('do it', {completionVerification: check});
    expect(result.run.status).toBe('limit_reached');
    expect(result.verification).toMatchObject({argv: original, files: ['candidate.txt'], status: 'failed', dispatched: true});
    expect(f.requests).toHaveLength(1);
    await expect(readFile(join(root, 'marker.txt'))).rejects.toThrow();
  } finally {await f.agent.close();}
}));

test('stale successful check requires another model response and fresh check', async () => fixture(async (root, check) => {
  check.argv = ['/bin/sh', '-c', 'if [ ! -f marker.txt ]; then printf changed > candidate.txt; touch marker.txt; fi'];
  const f = await create(root, [{text: 'first'}, {text: 'checked again'}]);
  try {
    const result = await f.agent.chat('do it', {completionVerification: check});
    expect(f.requests).toHaveLength(2); expect(f.requests[1]!.at(-1)?.content).toContain('candidate_changed_during_check');
    expect(result.verification?.status).toBe('passed');
  } finally {await f.agent.close();}
}));

for (const mode of ['unknown', 'denied', 'empty'] as const) test(`${mode} completion never blindly retries or reports success`, async () => fixture(async (root, check) => {
  if (mode === 'unknown') check.argv = ['/bin/sh', '-c', 'sleep 30 >/dev/null 2>&1 & exit 0'];
  if (mode === 'denied') {check.argv = ['/bin/sh', '-c', 'printf changed > marker.txt']; check.context = {...check.context, approval: {policy: 'deny', scopeId: 'deny'}};}
  const f = await create(root, [{text: mode === 'empty' ? '' : 'done'}]);
  try {
    await expect(f.agent.chat('do it', {completionVerification: check})).rejects.toThrow();
    expect(f.requests).toHaveLength(1); expect(f.agent.getSessionEvents().some(event => event.type === 'turn/completed')).toBe(false);
    if (mode === 'denied') await expect(readFile(join(root, 'marker.txt'))).rejects.toThrow();
  } finally {await f.agent.close();}
}));

test('cancellation while preparing a check settles without another request', async () => fixture(async (root, check) => {
  const f = await create(root, [{text: 'done'}]), controller = new AbortController(), receipts: CandidateVerificationReceipt[] = [];
  try {
    await expect(f.agent.chat('do it', {completionVerification: check, signal: controller.signal, onVerification: receipt => {
      receipts.push(receipt); if (!receipt.completedAt) controller.abort();
    }})).rejects.toThrow();
    expect(f.requests).toHaveLength(1); expect(receipts.at(-1)?.status).toBe('interrupted');
  } finally {await f.agent.close();}
}));

for (const failure of ['prepared', 'settled', 'feedback'] as const) test(`${failure} journal failure prevents another inference request`, async () => fixture(async (root, check) => {
  const backing = new InMemorySessionEventStore(); let rejected = false;
  const store: SessionEventStore = {read: id => backing.read(id), append: event => {
    const selected = failure === 'prepared' ? event.type === 'verification/started' : failure === 'settled' ? event.type === 'verification/recorded'
      : event.type === 'message/appended' && event.data.message.role === 'user' && String(event.data.message.content).startsWith('The explicitly configured candidate check');
    if (selected && !rejected) {rejected = true; throw new Error('fixture journal failure');} backing.append(event);
  }};
  if (failure === 'prepared') check.argv = ['/bin/sh', '-c', 'printf effect > marker.txt'];
  const f = await create(root, [{text: 'done'}], {store});
  try {
    await expect(f.agent.chat('do it', {completionVerification: check})).rejects.toThrow('journal failure'); expect(f.requests).toHaveLength(1);
    if (failure === 'prepared') await expect(readFile(join(root, 'marker.txt'))).rejects.toThrow();
    const recorded = f.agent.getSessionEvents().filter(event => event.type === 'verification/recorded');
    if (failure === 'settled') expect(recorded.at(-1)?.data.receipt.status).toBe('unknown');
    if (failure === 'feedback') expect(recorded.at(-1)?.data.receipt.status).toBe('failed');
  } finally {await f.agent.close();}
}));

test('tool exhaustion with an explicit check never buys an extra finalizer request or claims verification', async () => fixture(async (root, check) => {
  const f = await create(root, [{toolCall: {id: 'repair-only', name: 'repair', args: {}}}], {maxRounds: 1});
  try {
    const result = await f.agent.chat('do it', {completionVerification: check});
    expect(result.run.status).toBe('limit_reached'); expect(f.requests).toHaveLength(1);
    expect(result.verification).toBeUndefined(); expect(result.outcome).toBeUndefined();
    expect(f.agent.getSessionEvents().some(event => event.type.startsWith('verification/'))).toBe(false);
  } finally {await f.agent.close();}
}));

test('receipt observers cannot turn a failed check into a passing one', async () => fixture(async (root, check) => {
  const f = await create(root, [{text: 'done'}], {maxRounds: 1});
  try {
    const result = await f.agent.chat('do it', {completionVerification: check, onVerification: receipt => {
      if (receipt.completedAt) {receipt.status = 'passed'; receipt.stdout = 'tampered observer';}
    }});
    expect(result.run.status).toBe('limit_reached'); expect(result.verification?.status).toBe('failed');
    expect(result.verification?.stdout).toBe('candidate is broken');
  } finally {await f.agent.close();}
}));
