import {expect, test} from 'bun:test';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {defineTool, ok} from '../agent-harness/framework/tool';
import type {AdapterResponse, ChatMessage} from '../agent-harness/framework/adapters/types';
import {detectUserDirectedRequest, noninteractiveFeedback, noninteractivePromptBlock, NONINTERACTIVE_UNSETTLED_ERROR} from '../agent-harness/framework/settlement';

// The exact final answer that failed corpus round 2, SQLite repetition 3 (CLI-044).
const ROUND2_ANSWER = "I'm the Siftable assistant.\n\nYour `/app/trunc.db` is binary-truncated SQLite — I need shell access to carve it.\n\nApprove running these in `/app` so I can recover to `/app/recover.json`:\n1. `ls -l trunc.db; file trunc.db; hexdump -C trunc.db | head -n 50`\n2. `sqlite3 trunc.db \"PRAGMA integrity_check; SELECT sql FROM sqlite_master;\"`";

test('detects answers that ask the absent user to approve, decide, or act', () => {
  expect(detectUserDirectedRequest(ROUND2_ANSWER)?.cue).toMatch(/need shell access|Approve running these/);
  for (const text of [
    'Do you want me to apply the patch now?',
    'Should I proceed with deleting the stale rows?',
    'Let me know if you would like the migration applied as well.',
    'I need your permission to write to /app.',
    'Once you approve, I will run the test suite.',
    'Awaiting your confirmation before continuing.',
    'Please confirm whether the second table should be dropped.',
  ]) expect(detectUserDirectedRequest(text), text).toBeDefined();
});

test('leaves ordinary final answers alone', () => {
  for (const text of [
    '',
    'Recovered 9 rows into /app/recover.json and verified the JSON parses.',
    'Approved the pending request in the queue; the approval column now reads granted.',
    'The function now confirms that the token is valid before returning.',
    'Added `allow_reuse` to the config; the test suite passes (241 passed).',
    'I ran these commands: `ls`, `sqlite3 trunc.db .dump`. Output is in recover.json.',
    'Changes: README updated, CI workflow now runs on pull requests.',
  ]) expect(detectUserDirectedRequest(text), text).toBeUndefined();
});

test('prompt block and feedback name the policy and forbid asking again', () => {
  expect(noninteractivePromptBlock('allow')).toContain('pre-approved by policy');
  expect(noninteractivePromptBlock('deny')).toContain('denied by policy');
  const feedback = noninteractiveFeedback('allow', {cue: 'Approve running these'});
  expect(feedback).toContain('noninteractive_run');
  expect(feedback).toContain('Approve running these');
  expect(feedback).toContain('Do not ask again');
});

async function harness(responses: AdapterResponse[], maxRounds = 4) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-settlement-')));
  const requests: ChatMessage[][] = [];
  let recovered = 0;
  const agent = await createChatAgent({memory: false, maxToolRounds: maxRounds,
    session: {id: 'settlement'}, executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    tools: [defineTool({name: 'recover', description: 'Recover the database', inputSchema: {type: 'object', properties: {}}, handler: async () => {
      recovered += 1; return ok('recovered');
    }})],
    adapter: {name: 'fixture', model: 'fixture', chat: async (history) => {
      requests.push(structuredClone(history));
      const response = responses.shift(); if (!response) throw new Error('Unexpected extra model request'); return response;
    }},
  });
  return {agent, requests, recovered: () => recovered, close: async () => {await agent.close(); await rm(root, {recursive: true, force: true});}};
}

test('a user-directed answer in a noninteractive run gets one feedback round, then the model finishes', async () => {
  const f = await harness([{text: ROUND2_ANSWER}, {toolCall: {id: 'r1', name: 'recover', args: {}}}, {text: 'Recovered 9 rows into /app/recover.json.'}]);
  try {
    const result = await f.agent.chat('Recover /app/trunc.db to /app/recover.json', {noninteractive: {approvalPolicy: 'allow'}});
    expect(result).toMatchObject({text: 'Recovered 9 rows into /app/recover.json.', run: {status: 'completed'}});
    expect(f.recovered()).toBe(1);
    expect(f.requests).toHaveLength(3);
    const feedback = f.requests[1]!.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('noninteractive_run');
    expect(feedback.content).toContain('Approval policy is allow');
    const events = f.agent.getSessionEvents().filter(event => event.type === 'settlement/user-directed');
    expect(events.map(event => event.data)).toEqual([{cue: expect.any(String), action: 'feedback', approvalPolicy: 'allow'}]);
    expect(events[0]!.data.cue).toMatch(/need shell access|Approve running these/);
    expect(f.agent.getSessionEvents().filter(event => event.type === 'turn/started')).toHaveLength(1);
  } finally {await f.close();}
});

test('a rejected answer is never yielded as answer text; the stream carries its withdrawal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-settlement-stream-')));
  const responses: AdapterResponse[] = [{text: ROUND2_ANSWER}, {text: 'Recovered 9 rows into /app/recover.json.'}];
  const agent = await createChatAgent({memory: false, maxToolRounds: 4, session: {id: 'settlement-stream'},
    executionContext: () => ({workspaceRoot: root, sessionCwd: root}), tools: [],
    adapter: {name: 'fixture', model: 'fixture', chat: async (_history, _registry, options) => {
      const response = responses.shift(); if (!response) throw new Error('Unexpected extra model request');
      // Stream the answer as deltas the way a live provider would; streaming
      // is a headless contract and is deliberately not buffered.
      options?.onEvent?.({type: 'provider.text.delta', requestId: `req-${responses.length}`, delta: response.text!});
      return response;
    }}});
  try {
    const deltas: string[] = [];
    const chunks: Array<Record<string, unknown>> = [];
    let result: {text: string} | undefined;
    for await (const chunk of agent.chat('Recover /app/trunc.db', {stream: true, noninteractive: {approvalPolicy: 'allow'},
      onProviderEvent: event => {if (event.type === 'provider.text.delta') deltas.push(event.delta);}})) {
      if (chunk.type === 'text') chunks.push({type: 'text', text: chunk.text, streamed: chunk.streamed});
      if (chunk.type === 'settlement') chunks.push({type: 'settlement', ...chunk.settlement});
      if (chunk.type === 'done') result = chunk.result;
    }
    expect(result?.text).toBe('Recovered 9 rows into /app/recover.json.');
    expect(deltas).toEqual([ROUND2_ANSWER, 'Recovered 9 rows into /app/recover.json.']);
    // The withdrawn answer is announced before any answer text, and never appears as answer text.
    expect(chunks).toEqual([
      {type: 'settlement', action: 'feedback', cue: expect.stringMatching(/need shell access|Approve running these/), streamed: true},
      {type: 'text', text: 'Recovered 9 rows into /app/recover.json.', streamed: true},
    ]);
  } finally {await agent.close(); await rm(root, {recursive: true, force: true});}
});

test('a failing second answer is withdrawn on the stream before the run fails', async () => {
  const f = await harness([{text: ROUND2_ANSWER}, {text: 'Understood. Shall I proceed with the recovery commands?'}]);
  try {
    const seen: string[] = [];
    let failure: unknown;
    try {
      for await (const chunk of f.agent.chat('Recover the database', {stream: true, noninteractive: {approvalPolicy: 'allow'}})) {
        seen.push(chunk.type === 'settlement' ? `settlement:${chunk.settlement!.action}` : chunk.type);
      }
    } catch (error) { failure = error; }
    expect(String(failure)).toContain(NONINTERACTIVE_UNSETTLED_ERROR);
    expect(seen).toEqual(['settlement:feedback', 'settlement:failed']);
  } finally {await f.close();}
});

test('a second user-directed answer fails the run instead of reporting completion', async () => {
  const f = await harness([{text: ROUND2_ANSWER}, {text: 'Understood. Shall I proceed with the recovery commands?'}]);
  try {
    await expect(f.agent.chat('Recover the database', {noninteractive: {approvalPolicy: 'allow'}})).rejects.toThrow(NONINTERACTIVE_UNSETTLED_ERROR);
    expect(f.requests).toHaveLength(2);
    expect(f.recovered()).toBe(0);
    const events = f.agent.getSessionEvents().filter(event => event.type === 'settlement/user-directed');
    expect(events.map(event => event.data.action)).toEqual(['feedback', 'failed']);
  } finally {await f.close();}
});

test('an exhausted round allowance cannot be spent on asking the user', async () => {
  const f = await harness([{text: ROUND2_ANSWER}], 1);
  try {
    await expect(f.agent.chat('Recover the database', {noninteractive: {approvalPolicy: 'deny'}})).rejects.toThrow(NONINTERACTIVE_UNSETTLED_ERROR);
    expect(f.requests).toHaveLength(1);
  } finally {await f.close();}
});

test('interactive turns are untouched: the same answer is a normal final result', async () => {
  const f = await harness([{text: ROUND2_ANSWER}]);
  try {
    const result = await f.agent.chat('Recover the database');
    expect(result).toMatchObject({text: ROUND2_ANSWER, run: {status: 'completed'}});
    expect(f.agent.getSessionEvents().some(event => event.type === 'settlement/user-directed')).toBe(false);
  } finally {await f.close();}
});

test('quoted, fenced, and inline content never counts as a request to the reader', () => {
  const drafted = 'Here is the email draft you asked for:\n\n```\nHi Sam,\nPlease confirm whether Thursday works and let me know if not.\n```\n\nSaved to /app/draft.txt.';
  expect(detectUserDirectedRequest(drafted)).toBeUndefined();
  expect(detectUserDirectedRequest('> Should I proceed with the migration?\n\nThe quoted question above came from the ticket; I applied the migration and the tests pass.')).toBeUndefined();
  expect(detectUserDirectedRequest('Run `npm test` yourself and paste the output.')?.cue).toMatch(/yourself/);
  expect(detectUserDirectedRequest("You'll need to run the migration before the tests pass.")?.cue).toMatch(/need to run/);
});

test('the exhausted-round finalizer cannot end with a request to the reader', async () => {
  const f = await harness([{toolCall: {id: 'r1', name: 'recover', args: {}}}, {text: 'Approve running the verification commands and I will finish.'}], 1);
  try {
    await expect(f.agent.chat('Recover the database', {noninteractive: {approvalPolicy: 'allow'}})).rejects.toThrow(NONINTERACTIVE_UNSETTLED_ERROR);
    const events = f.agent.getSessionEvents().filter(event => event.type === 'settlement/user-directed');
    expect(events.map(event => event.data.action)).toEqual(['failed']);
  } finally {await f.close();}
});

test('a configured completion check settles the task instead of the detector', async () => {
  const {mkdtemp: mk, writeFile: wf, realpath: rp, rm: rmp} = await import('node:fs/promises');
  const root = await rp(await mk(join(tmpdir(), 'sift-settlement-check-')));
  await wf(join(root, 'candidate.txt'), 'repaired');
  const agent = await createChatAgent({memory: false, maxToolRounds: 2, session: {id: 'settlement-check'}, executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    tools: [], adapter: {name: 'fixture', model: 'fixture', chat: async () => ({text: ROUND2_ANSWER})}});
  try {
    const result = await agent.chat('Repair it', {noninteractive: {approvalPolicy: 'allow'}, completionVerification: {
      argv: ['/bin/sh', '-c', '[ "$(cat candidate.txt)" = repaired ]'], files: ['candidate.txt'],
      context: {workspaceRoot: root, sessionCwd: root, deadline: Date.now() + 10_000, approval: {policy: 'allow', scopeId: 'check'}}}});
    expect(result.verification?.status).toBe('passed');
    expect(result.run.status).toBe('completed');
    expect(agent.getSessionEvents().some(event => event.type === 'settlement/user-directed')).toBe(false);
  } finally {await agent.close(); await rmp(root, {recursive: true, force: true});}
});

test('lazy block-quote continuations stay quoted until a blank line', () => {
  expect(detectUserDirectedRequest('> Original ticket:\nPlease confirm whether the migration should run.\n\nI ran the migration and the suite passes.')).toBeUndefined();
  expect(detectUserDirectedRequest('> Original ticket:\nThe report was empty.\n\nPlease confirm whether I should also drop the table.')?.cue).toMatch(/confirm whether/);
});
