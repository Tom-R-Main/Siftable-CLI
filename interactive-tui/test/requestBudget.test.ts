import {expect, test} from 'bun:test';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {defineTool, ok} from '../agent-harness/framework/tool';
import type {AdapterResponse, ChatMessage} from '../agent-harness/framework/adapters/types';
import {ProviderHttpError, ProviderIncompleteError, reasoningOnlyTruncation} from '../agent-harness/framework/adapters/transport';
import {fitHistoryToRequestBudget, requestByteCeiling, PRUNE_STUB_PREFIX, estimateRequestBytes} from '../agent-harness/framework/request-budget';

function toolMessage(id: string, bytes: number): ChatMessage {
  return {role: 'tool', toolCallId: id, toolName: 'read_file', content: 'x'.repeat(bytes)};
}

test('lane ceilings: Meta is tight, others generous, env overrides', () => {
  expect(requestByteCeiling('Meta')).toBe(240_000);
  expect(requestByteCeiling('muse-spark-1.3-contributor')).toBe(240_000);
  expect(requestByteCeiling('openai')).toBe(800_000);
  process.env.SIFT_REQUEST_BYTE_CEILING = '1234';
  try { expect(requestByteCeiling('Meta')).toBe(1234); } finally { delete process.env.SIFT_REQUEST_BYTE_CEILING; }
});

test('pruning stubs the oldest large tool results, keeps the last ones, and stops once it fits', () => {
  const history: ChatMessage[] = [{role: 'user', content: 'task'}];
  for (let i = 0; i < 8; i++) history.push({role: 'assistant', content: '{}', toolCallId: `c${i}`, toolName: 'read_file'}, toolMessage(`c${i}`, 20_000));
  const before = estimateRequestBytes(history, 'sys');
  const outcome = fitHistoryToRequestBudget(history, 'sys', {ceilingBytes: 100_000, keepLast: 2});
  expect(outcome.beforeBytes).toBe(before);
  expect(outcome.afterBytes).toBeLessThanOrEqual(100_000);
  expect(outcome.pruned.map(p => p.callId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  const stubs = outcome.history.filter(m => m.role === 'tool' && String(m.content).startsWith(PRUNE_STUB_PREFIX));
  expect(stubs).toHaveLength(4);
  expect(String(stubs[0]!.content)).toContain('read_file call c0 returned 20000 bytes');
  expect(outcome.history.filter(m => m.role === 'tool' && !String(m.content).startsWith(PRUNE_STUB_PREFIX)).map(m => m.toolCallId)).toEqual(['c4', 'c5', 'c6', 'c7']);
  expect(outcome.history.filter(m => m.role !== 'tool')).toEqual(history.filter(m => m.role !== 'tool'));
  // Already-fitting history is returned untouched, same object.
  const small = fitHistoryToRequestBudget(history, 'sys', {ceilingBytes: 10_000_000});
  expect(small.history).toBe(history); expect(small.pruned).toEqual([]);
  // A second pass never re-prunes stubs and never touches protected results.
  const again = fitHistoryToRequestBudget(outcome.history, 'sys', {ceilingBytes: 1, keepLast: 2});
  expect(again.pruned.map(p => p.callId)).toEqual(['c4', 'c5']);
});

test('reasoning-only truncation is recognised; partial output is not', () => {
  expect(reasoningOnlyTruncation(new ProviderIncompleteError('Meta', 'length', false))).toBe(true);
  expect(reasoningOnlyTruncation(new ProviderIncompleteError('Meta', 'length', true))).toBe(false);
  expect(reasoningOnlyTruncation(new ProviderIncompleteError('Meta', 'content_filter', false))).toBe(false);
  expect(reasoningOnlyTruncation(new Error('length'))).toBe(false);
});

async function harness(script: Array<AdapterResponse | Error>, opts: {provider?: string; big?: number} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-request-budget-')));
  const requests: ChatMessage[][] = [];
  const agent = await createChatAgent({memory: false, maxToolRounds: 12, session: {id: 'request-budget'}, executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    tools: [defineTool({name: 'read_file', description: 'Read a file for the test', inputSchema: {type: 'object', properties: {}}, handler: async () => ok('y'.repeat(opts.big ?? 60_000))})],
    adapter: {name: opts.provider ?? 'Meta', model: 'muse-spark-1.3-contributor', chat: async (history) => {
      requests.push(structuredClone(history));
      const next = script.shift(); if (!next) throw new Error('Unexpected extra model request');
      if (next instanceof Error) throw next; return next;
    }},
  });
  return {agent, requests, close: async () => {await agent.close(); await rm(root, {recursive: true, force: true});}};
}

test('a reasoning-only output-limited response is replayed, bounded, and recorded', async () => {
  const f = await harness([new ProviderIncompleteError('Meta', 'length', false), new ProviderIncompleteError('Meta', 'length', false), {text: 'done'}]);
  try {
    const result = await f.agent.chat('go');
    expect(result.text).toBe('done'); expect(f.requests).toHaveLength(3);
    expect(f.agent.getSessionEvents().filter(e => e.type === 'model/incomplete-retry').map(e => e.data.attempt)).toEqual([1, 2]);
  } finally {await f.close();}
  const g = await harness([new ProviderIncompleteError('Meta', 'length', false), new ProviderIncompleteError('Meta', 'length', false), new ProviderIncompleteError('Meta', 'length', false)]);
  try {
    await expect(g.agent.chat('go')).rejects.toThrow(/incomplete \(length\)/);
    expect(g.requests).toHaveLength(3);
  } finally {await g.close();}
  const h = await harness([new ProviderIncompleteError('Meta', 'length', true)]);
  try {
    await expect(h.agent.chat('go')).rejects.toThrow(/incomplete/);
    expect(h.requests).toHaveLength(1);
  } finally {await h.close();}
});

test('older tool results are pruned before the request outgrows the Meta ceiling', async () => {
  process.env.SIFT_REQUEST_BYTE_CEILING = '200000';
  const calls = Array.from({length: 6}, (_, i) => ({toolCall: {id: `r${i}`, name: 'read_file', args: {}}}));
  const f = await harness([...calls, {text: 'done'}], {big: 45_000});
  try {
    const result = await f.agent.chat('read everything');
    expect(result.text).toBe('done');
    const pruned = f.agent.getSessionEvents().filter(e => e.type === 'model/request-pruned');
    expect(pruned.length).toBeGreaterThan(0);
    expect(pruned.every(e => e.data.reason === 'preemptive' && e.data.afterBytes <= 200_000)).toBe(true);
    expect(f.requests.every(r => JSON.stringify(r).length <= 200_000 + 2_000)).toBe(true);
    const last = f.requests.at(-1)!;
    expect(last.filter(m => m.role === 'tool' && String(m.content).startsWith(PRUNE_STUB_PREFIX)).length).toBeGreaterThan(0);
    expect(last.filter(m => m.role === 'tool' && !String(m.content).startsWith(PRUNE_STUB_PREFIX)).length).toBeGreaterThanOrEqual(1);
  } finally {delete process.env.SIFT_REQUEST_BYTE_CEILING; await f.close();}
});

test('an HTTP 413 prunes harder once and retries; a second 413 fails', async () => {
  const f = await harness([{toolCall: {id: 'a', name: 'read_file', args: {}}}, {toolCall: {id: 'b', name: 'read_file', args: {}}}, new ProviderHttpError('Meta', 413), {text: 'done'}], {big: 30_000});
  try {
    const result = await f.agent.chat('go');
    expect(result.text).toBe('done'); expect(f.requests).toHaveLength(4);
    const pruned = f.agent.getSessionEvents().filter(e => e.type === 'model/request-pruned');
    expect(pruned.map(e => e.data.reason)).toEqual(['http-413']);
    expect(f.requests[3]!.filter(m => m.role === 'tool' && String(m.content).startsWith(PRUNE_STUB_PREFIX))).toHaveLength(1);
  } finally {await f.close();}
  const g = await harness([{toolCall: {id: 'a', name: 'read_file', args: {}}}, {toolCall: {id: 'b', name: 'read_file', args: {}}}, new ProviderHttpError('Meta', 413), new ProviderHttpError('Meta', 413)], {big: 30_000});
  try {
    await expect(g.agent.chat('go')).rejects.toThrow(/413/);
    expect(g.requests).toHaveLength(4);
  } finally {await g.close();}
  // Nothing prunable (only the newest result exists): the 413 is terminal on the first occurrence.
  const h = await harness([{toolCall: {id: 'a', name: 'read_file', args: {}}}, new ProviderHttpError('Meta', 413)], {big: 30_000});
  try {
    await expect(h.agent.chat('go')).rejects.toThrow(/413/);
    expect(h.requests).toHaveLength(2);
  } finally {await h.close();}
});
