import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtemp, readdir, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import * as confirmGate from '../confirmGate';
import * as questionGate from '../questionGate';
import {JsonlSessionEventStore} from '../agent-harness/framework/session';
import {serveLines, SessionServer, WireEventLog, type SessionEngine, type WireEvent} from '../sessionServer';
import type {BrainAskResult, BrainEvent} from '../brain';

type Line = Record<string, any>;

const roots: string[] = [];
afterEach(async () => {
  confirmGate.resetBypass();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

/** A scripted engine: each prompt names a behavior; no provider, no network. */
function scriptedEngine(trace: string[]): SessionEngine {
  return {
    async ask(input: string, onEvent: (event: BrainEvent) => void, signal: AbortSignal): Promise<BrainAskResult> {
      const receipts = [{requestId: `r-${input}`, provider: 'fixture', requestedModel: 'fixture', attempts: 1, mode: 'buffered' as const,
        outcome: 'completed' as const, usage: {inputTokens: 10, outputTokens: 4, cachedInputTokens: 2}}];
      if (input.startsWith('say ')) {
        onEvent({type: 'token', content: input.slice(4)});
        return {text: input.slice(4), status: 'completed', providerReceipts: receipts};
      }
      if (input === 'write') {
        onEvent({type: 'tool_call', toolCall: {name: 'write_file', args: {path: 'a.txt'}}});
        const decision = await confirmGate.requestApproval({kind: 'write', path: 'a.txt', detail: '3 bytes'}, signal);
        trace.push(`decision:${decision}`);
        return {text: `decision ${decision}`, status: 'completed', providerReceipts: receipts};
      }
      if (input === 'ask') {
        const outcome = await questionGate.requestAnswer({question: 'Which file?', options: ['a', 'b']}, signal);
        trace.push(`answer:${JSON.stringify(outcome)}`);
        return {text: 'answer' in outcome ? `chose ${outcome.answer}` : `no answer ${outcome.reason}`, status: 'completed', providerReceipts: receipts};
      }
      if (input === 'hang' || input === 'hang-approval') {
        if (input === 'hang-approval') void confirmGate.requestApproval({kind: 'command', path: 'rm -rf x', detail: 'cwd=/', allowBypass: false}, signal);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
        // The loop takes time to unwind after abort; the stop event must wait.
        await new Promise(resolve => setTimeout(resolve, 30));
        trace.push('loop-stopped');
        return {text: '', progressText: 'partial', status: 'interrupted', jobCleanup: 'confirmed', providerReceipts: receipts};
      }
      throw new Error(`unscripted input ${input}`);
    },
    async close() { trace.push('closed'); },
  };
}

async function harness(options: {root?: string; session?: string; deadlineMs?: number; trace?: string[]} = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'sift-session-server-'));
  if (!options.root) roots.push(root);
  const trace = options.trace ?? [];
  const lines: Line[] = [];
  const session = options.session ?? 'fixture-session';
  const log = new WireEventLog({rootDir: root, session, leaseStore: dir => new JsonlSessionEventStore({rootDir: dir})});
  const write = (line: string) => {
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    if (parsed.type === 'turn.stopped' && !parsed.recovered) expect(trace).toContain('loop-stopped');
    lines.push(parsed);
  };
  const server = new SessionServer({session, provider: 'fixture', model: 'fixture', cwd: root, deadlineMs: options.deadlineMs ?? 5_000,
    engine: scriptedEngine(trace), gates: {...confirmGate, ...questionGate}, log, write});
  let next = 0;
  const send = async (command: Record<string, unknown>) => {
    const id = `c${++next}`;
    await server.handleLine(JSON.stringify({id, ...command}));
    const response = lines.find(line => line.type === 'response' && line.id === id);
    if (!response) throw new Error(`no response for ${id}`);
    return response;
  };
  const events = () => lines.filter(line => line.type !== 'response') as WireEvent[];
  const waitFor = async (predicate: (line: Line) => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = lines.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error(`timed out; saw ${JSON.stringify(lines.map(line => line.type))}`);
  };
  return {root, server, lines, trace, send, events, waitFor, log};
}

function assertMonotonic(events: WireEvent[]) {
  events.forEach((event, index) => {
    if (index > 0) expect(event.seq).toBe(events[index - 1]!.seq + 1);
    expect(event.schemaVersion).toBe(1);
  });
}

describe('session server protocol', () => {
  test('initialize reports capabilities; follow-up turns run in one process with usage', async () => {
    const h = await harness();
    const init = await h.send({type: 'initialize', protocolVersion: 1});
    expect(init).toMatchObject({ok: true, protocolVersion: 1, session: 'fixture-session', lastSeq: 0, resumed: false,
      capabilities: {prompt: {followUp: true, concurrentTurns: 1}, questions: true, cancel: {confirmedStop: true}, replay: {durable: true}, usage: true}});
    const first = await h.send({type: 'prompt', input: 'say one'});
    expect(first.ok).toBe(true);
    await h.waitFor(line => line.type === 'turn.completed' && line.turnId === first.turnId);
    const second = await h.send({type: 'prompt', input: 'say two'});
    await h.waitFor(line => line.type === 'turn.completed' && line.turnId === second.turnId);
    expect(second.turnId).not.toBe(first.turnId);
    const completed = h.events().filter(event => event.type === 'turn.completed');
    expect(completed.map(event => event.text)).toEqual(['one', 'two']);
    const usage = await h.send({type: 'usage'});
    expect(usage.usage).toEqual({session: {requests: 2, inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, totalTokens: 28},
      lastTurn: {requests: 1, inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14}, turns: 2});
    const usageEvents = h.events().filter(event => event.type === 'usage');
    expect(usageEvents).toHaveLength(2);
    // Usage precedes the terminal event of its turn.
    expect(usageEvents[1]!.seq).toBeLessThan(completed[1]!.seq);
    assertMonotonic(h.events());
    expect(await h.send({type: 'shutdown'})).toMatchObject({ok: true, status: 'closed', exitCode: 0});
    expect(h.events().at(-1)).toMatchObject({type: 'session.closed', reason: 'client', turns: 2});
    expect(h.trace).toContain('closed');
  });

  test('approval round-trips by request id; a duplicate response is reported, never applied twice', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    const turn = await h.send({type: 'prompt', input: 'write'});
    const request = await h.waitFor(line => line.type === 'approval.request');
    expect(request).toMatchObject({turnId: turn.turnId, kind: 'write', path: 'a.txt', decisions: ['deny', 'allow', 'always', 'bypass']});
    expect(request).not.toHaveProperty('authorityScope');
    const applied = await h.send({type: 'approval.respond', requestId: request.requestId, decision: 'allow'});
    expect(applied).toMatchObject({ok: true, status: 'applied', decision: 'allow'});
    const duplicate = await h.send({type: 'approval.respond', requestId: request.requestId, decision: 'deny'});
    expect(duplicate).toMatchObject({ok: true, status: 'already_resolved', decision: 'allow', source: 'client'});
    await h.waitFor(line => line.type === 'turn.completed');
    expect(h.trace.filter(entry => entry.startsWith('decision:'))).toEqual(['decision:allow']);
    expect(h.events().filter(event => event.type === 'approval.resolved')).toHaveLength(1);
    const unknown = await h.send({type: 'approval.respond', requestId: 'nope', decision: 'allow'});
    expect(unknown).toMatchObject({ok: false, error: {code: 'unknown_request'}});
    await h.send({type: 'shutdown'});
  });

  test('an unoffered decision is refused and the request stays answerable', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'hang-approval'});
    const request = await h.waitFor(line => line.type === 'approval.request');
    expect(request.decisions).toEqual(['deny', 'allow', 'always']);
    expect(await h.send({type: 'approval.respond', requestId: request.requestId, decision: 'bypass'}))
      .toMatchObject({ok: false, error: {code: 'decision_not_offered'}});
    expect(confirmGate.pendingConfirmCount()).toBe(1);
    // Cancelling the turn revokes the pending request before the stop event.
    await h.send({type: 'cancel'});
    const stopped = await h.waitFor(line => line.type === 'turn.stopped');
    const revoked = h.events().find(event => event.type === 'approval.resolved')!;
    expect(revoked).toMatchObject({requestId: request.requestId, decision: 'deny', source: 'cancelled'});
    expect(revoked.seq).toBeLessThan(stopped.seq);
    expect(await h.send({type: 'approval.respond', requestId: request.requestId, decision: 'allow'}))
      .toMatchObject({ok: true, status: 'already_resolved', decision: 'deny', source: 'cancelled'});
    expect(confirmGate.pendingConfirmCount()).toBe(0);
    await h.send({type: 'shutdown'});
  });

  test('question and answer round-trip; a repeated answer is not applied', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'ask'});
    const question = await h.waitFor(line => line.type === 'question.request');
    expect(question).toMatchObject({question: 'Which file?', options: ['a', 'b']});
    expect(await h.send({type: 'question.answer', requestId: question.requestId, answer: 'b'})).toMatchObject({status: 'applied', outcome: 'answered'});
    expect(await h.send({type: 'question.answer', requestId: question.requestId, answer: 'a'})).toMatchObject({status: 'already_resolved', outcome: 'answered'});
    const done = await h.waitFor(line => line.type === 'turn.completed');
    expect(done.text).toBe('chose b');
    // A decline is also a single, final outcome.
    await h.send({type: 'prompt', input: 'ask'});
    const second = await h.waitFor(line => line.type === 'question.request' && line.requestId !== question.requestId);
    expect(await h.send({type: 'question.answer', requestId: second.requestId, decline: true})).toMatchObject({status: 'applied', outcome: 'declined'});
    await h.waitFor(line => line.type === 'turn.completed' && line.text === 'no answer declined');
    await h.send({type: 'shutdown'});
  });

  test('cancel emits one confirmed stop after the loop unwinds; the session accepts the next turn', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    const turn = await h.send({type: 'prompt', input: 'hang'});
    await h.waitFor(line => line.type === 'turn.started');
    expect(await h.send({type: 'prompt', input: 'say too-soon'})).toMatchObject({ok: false, error: {code: 'turn_in_progress'}});
    expect(await h.send({type: 'cancel'})).toMatchObject({ok: true, status: 'stopping', turnId: turn.turnId});
    expect(await h.send({type: 'cancel'})).toMatchObject({ok: true, status: 'already_stopping'});
    const stopped = await h.waitFor(line => line.type === 'turn.stopped');
    expect(stopped).toMatchObject({turnId: turn.turnId, confirmed: true, reason: 'client', status: 'interrupted', jobCleanup: 'confirmed', progressText: 'partial'});
    const forTurn = h.events().filter(event => event.turnId === turn.turnId && String(event.type).startsWith('turn.') && event.type !== 'turn.started');
    expect(forTurn).toHaveLength(1);
    expect(await h.send({type: 'cancel'})).toMatchObject({ok: true, status: 'no_active_turn'});
    await h.send({type: 'prompt', input: 'say after'});
    await h.waitFor(line => line.type === 'turn.completed' && line.text === 'after');
    await h.send({type: 'shutdown'});
  });

  test('the turn deadline stops the loop with a confirmed stop', async () => {
    const h = await harness({deadlineMs: 20});
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'hang'});
    expect(await h.waitFor(line => line.type === 'turn.stopped')).toMatchObject({reason: 'deadline', confirmed: true});
    await h.send({type: 'shutdown'});
  });

  test('shutdown during a turn waits for the confirmed stop before closing', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'hang'});
    await h.waitFor(line => line.type === 'turn.started');
    expect(await h.send({type: 'shutdown'})).toMatchObject({ok: true, exitCode: 0});
    const types = h.events().map(event => event.type);
    expect(types.indexOf('turn.stopped')).toBeLessThan(types.indexOf('session.closed'));
    expect(h.events().find(event => event.type === 'turn.stopped')).toMatchObject({reason: 'shutdown'});
    expect(await h.send({type: 'usage'})).toMatchObject({ok: false, error: {code: 'shutting_down'}});
  });

  test('replay from a cursor after reconnecting to a resumed session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-server-'));
    roots.push(root);
    const first = await harness({root});
    await first.send({type: 'initialize', protocolVersion: 1});
    await first.send({type: 'prompt', input: 'say persisted'});
    await first.waitFor(line => line.type === 'turn.completed');
    const cursor = first.events().find(event => event.type === 'turn.started')!.seq;
    const live = first.events();
    // In-process replay returns the same events without re-emitting them.
    const inProcess = await first.send({type: 'replay', after: cursor, limit: 2});
    expect(inProcess).toMatchObject({ok: true, through: cursor + 2, more: true});
    expect(inProcess.events).toEqual(live.filter(event => event.seq > cursor).slice(0, 2));
    await first.send({type: 'shutdown'});
    const firstEvents = first.events();

    // The log file is private to the user.
    const [file] = (await readdir(join(root, 'wire'))).filter(name => name.endsWith('.wire.jsonl'));
    expect((await stat(join(root, 'wire', file!))).mode & 0o077).toBe(0);

    const second = await harness({root});
    const init = await second.send({type: 'initialize', protocolVersion: 1});
    expect(init).toMatchObject({resumed: true, lastSeq: firstEvents.at(-1)!.seq});
    const replay = await second.send({type: 'replay', after: cursor});
    expect(replay).toMatchObject({ok: true, more: false, lastSeq: firstEvents.at(-1)!.seq});
    expect(replay.events).toEqual(firstEvents.filter(event => event.seq > cursor));
    await second.send({type: 'prompt', input: 'say continued'});
    const next = await second.waitFor(line => line.type === 'turn.started');
    expect(next.seq).toBe(firstEvents.at(-1)!.seq + 1);
    expect(await second.send({type: 'replay', after: 10_000})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    await second.send({type: 'shutdown'});
  });

  test('a second process cannot serve a leased session; a crashed turn is closed once on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-server-'));
    roots.push(root);
    const leaseStore = (dir: string) => new JsonlSessionEventStore({rootDir: dir});
    const log = new WireEventLog({rootDir: root, session: 'crashed', leaseStore});
    expect(() => new WireEventLog({rootDir: root, session: 'crashed', leaseStore})).toThrow();
    const ts = new Date().toISOString();
    log.append({schemaVersion: 1, seq: 1, session: 'crashed', ts, type: 'turn.started', turnId: 't1'});
    log.append({schemaVersion: 1, seq: 2, session: 'crashed', ts, type: 'token', turnId: 't1', content: 'x'});
    log.close();
    // A torn, uncommitted final fragment is discarded on open.
    const {appendFileSync} = await import('node:fs');
    appendFileSync(log.path, '{"schemaVersion":1,"seq":3');
    const resumed = await harness({root, session: 'crashed'});
    expect(resumed.events()).toEqual([expect.objectContaining({type: 'turn.stopped', turnId: 't1', seq: 3, recovered: true, reason: 'process_exit'})]);
    await resumed.send({type: 'shutdown'});
    const again = await harness({root, session: 'crashed'});
    expect(again.events()).toHaveLength(0);
    await again.send({type: 'shutdown'});
    const text = await readFile(log.path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('malformed commands are rejected without disturbing the session', async () => {
    const h = await harness();
    await h.server.handleLine('not json');
    await h.server.handleLine('[1,2]');
    await h.server.handleLine(JSON.stringify({type: 'initialize', protocolVersion: 1}));
    await h.server.handleLine(JSON.stringify({id: {}, type: 'usage'}));
    expect(h.lines.map(line => line.error?.code)).toEqual(['parse_error', 'invalid_request', 'invalid_request', 'invalid_request']);
    expect(await h.send({type: 'prompt', input: 'say early'})).toMatchObject({ok: false, error: {code: 'not_initialized'}});
    expect(await h.send({type: 'initialize', protocolVersion: 2})).toMatchObject({ok: false, error: {code: 'unsupported_version'}});
    await h.send({type: 'initialize', protocolVersion: 1});
    expect(await h.send({type: 'bogus'})).toMatchObject({ok: false, error: {code: 'unknown_command'}});
    expect(await h.send({type: 'prompt', input: ''})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(await h.send({type: 'approval.respond', requestId: 'x', decision: 'maybe'})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(await h.send({type: 'question.answer', requestId: 'x'})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(await h.send({type: 'replay', after: -1})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(h.events()).toHaveLength(0);
    await h.send({type: 'prompt', input: 'say still-alive'});
    await h.waitFor(line => line.type === 'turn.completed' && line.text === 'still-alive');
    await h.send({type: 'shutdown'});
  });

  test('the line reader rejects an oversized line, keeps serving, and shuts down on EOF', async () => {
    const h = await harness();
    const input = new PassThrough();
    const written: string[] = [];
    const served = serveLines(h.server, input, line => written.push(line));
    input.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
    input.write(`${JSON.stringify({id: 1, type: 'initialize', protocolVersion: 1})}\r\n`);
    input.write(`${JSON.stringify({id: 2, type: 'prompt', input: 'say eof'})}\n`);
    await h.waitFor(line => line.type === 'turn.completed');
    input.end();
    expect(await served).toBe(0);
    expect(written.map(line => JSON.parse(line).error?.code)).toEqual(['line_too_long']);
    expect(h.lines.find(line => line.id === 1)).toMatchObject({ok: true});
    expect(h.events().at(-1)).toMatchObject({type: 'session.closed', reason: 'eof'});
    expect(input.listenerCount('data')).toBe(0);
  });
});
