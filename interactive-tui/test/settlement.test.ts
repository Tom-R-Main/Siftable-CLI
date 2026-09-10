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
