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

/**
 * A Codex-shaped engine: codexAsk returns `{text}` with no status on success,
 * and after an interrupt reports whether app-server confirmed the turn ended.
 */
function codexEngine(trace: string[]): SessionEngine {
  return {
    kind: 'codex',
    async ask(input: string, onEvent: (event: BrainEvent) => void, signal: AbortSignal): Promise<BrainAskResult> {
      if (input === 'codex ok') {
        onEvent({type: 'token', content: 'hi'});
        onEvent({type: 'done', message: {content: 'hi'}});
        return {text: 'hi'};
      }
      if (input === 'codex error') return {text: '', error: 'codex turn failed'};
      if (input === 'codex usage then unconfirmed') {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
        trace.push('loop-stopped');
        return {text: '', status: 'interrupted', stopConfirmed: false, error: 'Codex did not confirm the turn stopped within 10000 ms',
          engineUsage: {requests: 1, inputTokens: 7, outputTokens: 1, cachedInputTokens: 0, totalTokens: 8}};
      }
      if (input === 'codex usage') return {text: 'hi', engineUsage: {requests: 2, inputTokens: 30, outputTokens: 5, cachedInputTokens: 10, totalTokens: 35}};
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      trace.push('loop-stopped');
      return {text: 'partial', status: 'interrupted', stopConfirmed: input === 'codex hang confirmed'};
    },
    async close() { trace.push('closed'); },
  };
}

/** A scripted engine: each prompt names a behavior; no provider, no network. */
function scriptedEngine(trace: string[]): SessionEngine {
  return {
    kind: 'harness',
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
      if (input === 'hang-cleanup-fails') {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
        trace.push('loop-stopped');
        // agentHarnessAsk's shape when processJobs.stopSession throws.
        return {text: '', status: 'interrupted', jobCleanup: 'unknown', providerReceipts: receipts,
          error: 'job stop failed; process ownership retained, retry session shutdown'};
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

async function harness(options: {root?: string; session?: string; deadlineMs?: number; trace?: string[]; engine?: 'harness' | 'codex'} = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'sift-session-server-'));
  if (!options.root) roots.push(root);
  const trace = options.trace ?? [];
  const lines: Line[] = [];
  const session = options.session ?? 'fixture-session';
  const log = new WireEventLog({rootDir: root, session, leaseStore: dir => new JsonlSessionEventStore({rootDir: dir})});
  // Observe fsyncs: every event the client sees must already be durable.
  let durable = log.lastSeq;
  const violations: number[] = [];
  const sync = log.sync.bind(log);
  log.sync = () => { const through = log.lastSeq; sync(); durable = through; };
  const write = (line: string) => {
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    if (typeof parsed.seq === 'number' && parsed.seq > durable) violations.push(parsed.seq);
    if (parsed.type === 'turn.stopped' && !parsed.recovered) expect(trace).toContain('loop-stopped');
    lines.push(parsed);
  };
  const server = new SessionServer({session, provider: 'fixture', model: 'fixture', cwd: root, deadlineMs: options.deadlineMs ?? 5_000,
    engine: options.engine === 'codex' ? codexEngine(trace) : scriptedEngine(trace), gates: {...confirmGate, ...questionGate}, log, write});
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
  return {root, server, lines, trace, send, events, waitFor, log, violations};
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
      capabilities: {prompt: {followUp: true, concurrentTurns: 1}, questions: true, cancel: {confirmedStop: true}, replay: {durable: true}, usage: {source: 'provider_receipts', mayBeUnavailable: false}}});
    const first = await h.send({type: 'prompt', input: 'say one'});
    expect(first.ok).toBe(true);
    await h.waitFor(line => line.type === 'turn.completed' && line.turnId === first.turnId);
    const second = await h.send({type: 'prompt', input: 'say two'});
    await h.waitFor(line => line.type === 'turn.completed' && line.turnId === second.turnId);
    expect(second.turnId).not.toBe(first.turnId);
    const completed = h.events().filter(event => event.type === 'turn.completed');
    expect(completed.map(event => event.text)).toEqual(['one', 'two']);
    const usage = await h.send({type: 'usage'});
    expect(usage.usage).toEqual({complete: true, session: {requests: 2, inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, totalTokens: 28},
      lastTurn: {requests: 1, inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14}, turns: 2});
    const usageEvents = h.events().filter(event => event.type === 'usage');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[1]).toMatchObject({session: 'fixture-session', cumulative: {requests: 2, totalTokens: 28}, turn: {requests: 1}});
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
    // Cumulative usage and the turn count survive the restart.
    expect((await second.send({type: 'usage'})).usage).toEqual({turns: 1, complete: true,
      session: {requests: 1, inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14},
      lastTurn: {requests: 1, inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14}});
    const replay = await second.send({type: 'replay', after: cursor});
    expect(replay).toMatchObject({ok: true, more: false, lastSeq: firstEvents.at(-1)!.seq});
    expect(replay.events).toEqual(firstEvents.filter(event => event.seq > cursor));
    await second.send({type: 'prompt', input: 'say continued'});
    const next = await second.waitFor(line => line.type === 'turn.started');
    expect(next.seq).toBe(firstEvents.at(-1)!.seq + 1);
    expect(await second.waitFor(line => line.type === 'usage')).toMatchObject({session: 'fixture-session', cumulative: {requests: 2, totalTokens: 28}});
    await second.waitFor(line => line.type === 'turn.completed');
    expect((await second.send({type: 'usage'})).usage.turns).toBe(2);
    expect(await second.send({type: 'replay', after: 10_000})).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    await second.send({type: 'shutdown'});
  });

  test('a second process cannot serve a leased session; a crashed turn is closed once, unconfirmed, on resume', async () => {
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
    // A dead process proves nothing about its tool loop: never confirmed.
    expect(resumed.events()).toEqual([expect.objectContaining({type: 'usage', turnId: 't1', seq: 3, turn: null, complete: false}),
      expect.objectContaining({type: 'turn.stop_unconfirmed', turnId: 't1', seq: 4, recovered: true,
      reason: 'process_exit', confirmed: false})]);
    // Its loop cannot continue here, so the resumed session still takes turns.
    await resumed.send({type: 'initialize', protocolVersion: 1});
    await resumed.send({type: 'prompt', input: 'say resumed'});
    await resumed.waitFor(line => line.type === 'turn.completed' && line.text === 'resumed');
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
    const served = serveLines(h.server, input);
    input.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
    input.write(`${JSON.stringify({id: 1, type: 'initialize', protocolVersion: 1})}\r\n`);
    input.write(`${JSON.stringify({id: 2, type: 'prompt', input: 'say eof'})}\n`);
    await h.waitFor(line => line.type === 'turn.completed');
    input.end();
    expect(await served).toBe(0);
    expect(h.lines.filter(line => line.type === 'response' && !line.ok).map(line => line.error.code)).toEqual(['line_too_long']);
    expect(h.lines.find(line => line.id === 1)).toMatchObject({ok: true});
    expect(h.events().at(-1)).toMatchObject({type: 'session.closed', reason: 'eof'});
    expect(input.listenerCount('data')).toBe(0);
  });

  test('no event reaches the client before an fsync covers its seq', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'write'});
    const request = await h.waitFor(line => line.type === 'approval.request');
    await h.send({type: 'approval.respond', requestId: request.requestId, decision: 'deny'});
    await h.waitFor(line => line.type === 'turn.completed');
    await h.send({type: 'prompt', input: 'say more'});
    await h.waitFor(line => line.type === 'turn.completed' && line.text === 'more');
    await h.send({type: 'shutdown'});
    expect(h.events().length).toBeGreaterThan(8);
    expect(h.violations).toEqual([]);
  });

  test('a completed Codex turn is turn.completed; a Codex error is turn.failed', async () => {
    const h = await harness({engine: 'codex'});
    await h.send({type: 'initialize', protocolVersion: 1});
    const ok = await h.send({type: 'prompt', input: 'codex ok'});
    expect(await h.waitFor(line => line.turnId === ok.turnId && String(line.type).startsWith('turn.') && line.type !== 'turn.started'))
      .toMatchObject({type: 'turn.completed', status: 'completed', text: 'hi'});
    const bad = await h.send({type: 'prompt', input: 'codex error'});
    expect(await h.waitFor(line => line.turnId === bad.turnId && String(line.type).startsWith('turn.') && line.type !== 'turn.started'))
      .toMatchObject({type: 'turn.failed', status: 'failed', error: 'codex turn failed'});
    await h.send({type: 'shutdown'});
  });

  test('a Codex cancel is confirmed only when the engine proves the turn ended', async () => {
    const confirmed = await harness({engine: 'codex'});
    await confirmed.send({type: 'initialize', protocolVersion: 1});
    await confirmed.send({type: 'prompt', input: 'codex hang confirmed'});
    await confirmed.send({type: 'cancel'});
    expect(await confirmed.waitFor(line => line.type === 'turn.stopped')).toMatchObject({confirmed: true, reason: 'client'});
    await confirmed.send({type: 'prompt', input: 'codex ok'});
    await confirmed.waitFor(line => line.type === 'turn.completed');
    await confirmed.send({type: 'shutdown'});

    const unconfirmed = await harness({engine: 'codex'});
    await unconfirmed.send({type: 'initialize', protocolVersion: 1});
    const turn = await unconfirmed.send({type: 'prompt', input: 'codex hang'});
    await unconfirmed.send({type: 'cancel'});
    const outcome = await unconfirmed.waitFor(line => line.turnId === turn.turnId && String(line.type).startsWith('turn.') && line.type !== 'turn.started');
    expect(outcome).toMatchObject({type: 'turn.stop_unconfirmed', confirmed: false, reason: 'client'});
    expect(unconfirmed.events().some(event => event.type === 'turn.stopped')).toBe(false);
    // One tool loop per session: no new turn beside one that may still run.
    expect(await unconfirmed.send({type: 'prompt', input: 'codex ok'})).toMatchObject({ok: false, error: {code: 'stop_unconfirmed'}});
    await unconfirmed.send({type: 'shutdown'});
  });

  function reopened(root: string, leaseStore: (dir: string) => JsonlSessionEventStore, synced: string[]) {
    const log = new WireEventLog({rootDir: root, session: 'dir-sync', leaseStore, syncDirectory: dir => synced.push(dir)});
    expect(synced).toHaveLength(2);
    log.close();
  }

  test('a newly created wire log syncs its directory before any event is sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-server-'));
    roots.push(root);
    const synced: string[] = [];
    const leaseStore = (dir: string) => new JsonlSessionEventStore({rootDir: dir});
    const log = new WireEventLog({rootDir: root, session: 'dir-sync', leaseStore, syncDirectory: dir => synced.push(dir)});
    expect(synced).toEqual([join(root, 'wire')]);
    const written: string[] = [];
    const server = new SessionServer({session: 'dir-sync', provider: 'fixture', model: 'fixture', cwd: root, deadlineMs: 5_000,
      engine: scriptedEngine([]), gates: {...confirmGate, ...questionGate}, log, write: line => { written.push(`${synced.length}:${line}`); }});
    await server.handleLine(JSON.stringify({id: 1, type: 'initialize', protocolVersion: 1}));
    await server.handleLine(JSON.stringify({id: 2, type: 'prompt', input: 'say durable'}));
    await server.shutdown('client');
    expect(written.filter(line => line.includes('"seq"')).every(line => line.startsWith('1:'))).toBe(true);
    reopened(root, leaseStore, synced);
  });

  test('Codex sessions advertise no questions and report usage only when app-server supplied it', async () => {
    const h = await harness({engine: 'codex'});
    const init = await h.send({type: 'initialize', protocolVersion: 1});
    expect(init.capabilities).toMatchObject({questions: false, usage: {source: 'codex_token_usage_notifications', mayBeUnavailable: true}});
    await h.send({type: 'prompt', input: 'codex usage'});
    expect(await h.waitFor(line => line.type === 'usage')).toMatchObject({turn: {requests: 2, inputTokens: 30, totalTokens: 35}, complete: true});
    await h.waitFor(line => line.type === 'turn.completed');
    await h.send({type: 'prompt', input: 'codex ok'});
    await h.waitFor(line => line.type === 'turn.completed' && h.events().filter(event => event.type === 'turn.completed').length === 2);
    const unavailable = h.events().filter(event => event.type === 'usage')[1]!;
    expect(unavailable).toMatchObject({turn: null, complete: false, cumulative: {requests: 2, totalTokens: 35}});
    expect((await h.send({type: 'usage'})).usage).toEqual({turns: 2, complete: false, lastTurn: null,
      session: {requests: 2, inputTokens: 30, outputTokens: 5, cachedInputTokens: 10, totalTokens: 35}});
    await h.send({type: 'shutdown'});
  });

  test('a harness cancel whose job cleanup is unknown is unconfirmed and blocks new turns', async () => {
    const h = await harness();
    await h.send({type: 'initialize', protocolVersion: 1});
    const turn = await h.send({type: 'prompt', input: 'hang-cleanup-fails'});
    await h.waitFor(line => line.type === 'turn.started');
    await h.send({type: 'cancel'});
    const outcome = await h.waitFor(line => line.turnId === turn.turnId && String(line.type).startsWith('turn.') && line.type !== 'turn.started');
    expect(outcome).toMatchObject({type: 'turn.stop_unconfirmed', confirmed: false, reason: 'client', jobCleanup: 'unknown'});
    expect(await h.send({type: 'prompt', input: 'say more'})).toMatchObject({ok: false, error: {code: 'stop_unconfirmed'}});
    await h.send({type: 'shutdown'});
  });

  async function deadSession(events: Array<Record<string, unknown>>) {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-server-'));
    roots.push(root);
    const log = new WireEventLog({rootDir: root, session: 'dead', leaseStore: dir => new JsonlSessionEventStore({rootDir: dir})});
    const ts = new Date().toISOString();
    events.forEach((event, index) => log.append({schemaVersion: 1, seq: index + 1, session: 'dead', ts, type: 'status', ...event} as WireEvent));
    log.close();
    return root;
  }
  const usageOf = (n: number) => ({requests: 1, inputTokens: n, outputTokens: 1, cachedInputTokens: 0, totalTokens: n + 1});

  test('recovery records the dead turn usage as unavailable, and a later resume keeps it', async () => {
    const root = await deadSession([
      {type: 'turn.started', turnId: 't1'},
      {type: 'usage', turnId: 't1', turn: usageOf(10), cumulative: usageOf(10), complete: true},
      {type: 'turn.completed', turnId: 't1', status: 'completed', text: 'ok'},
      {type: 'turn.started', turnId: 't2'},
    ]);
    const first = await harness({root, session: 'dead'});
    expect(first.events().map(event => event.type)).toEqual(['usage', 'turn.stop_unconfirmed']);
    expect(first.events()[0]).toMatchObject({turnId: 't2', turn: null, complete: false});
    await first.send({type: 'initialize', protocolVersion: 1});
    expect((await first.send({type: 'usage'})).usage).toEqual({turns: 2, complete: false, lastTurn: null, session: usageOf(10)});
    await first.send({type: 'shutdown'});
    const second = await harness({root, session: 'dead'});
    await second.send({type: 'initialize', protocolVersion: 1});
    expect((await second.send({type: 'usage'})).usage).toEqual({turns: 2, complete: false, lastTurn: null, session: usageOf(10)});
    await second.send({type: 'shutdown'});
  });

  test('recovery rebuilds requests; pending ones get a logged process_exit resolution', async () => {
    const root = await deadSession([
      {type: 'turn.started', turnId: 't1'},
      {type: 'approval.request', turnId: 't1', requestId: 'a-old', kind: 'write', path: 'x', detail: '', decisions: ['deny', 'allow', 'always', 'bypass']},
      {type: 'approval.resolved', turnId: 't1', requestId: 'a-old', decision: 'allow', source: 'client'},
      {type: 'approval.request', turnId: 't1', requestId: 'a-open', kind: 'command', path: 'ls', detail: '', decisions: ['deny', 'allow']},
      {type: 'question.request', turnId: 't1', requestId: 'q-open', question: 'Which?'},
    ]);
    const first = await harness({root, session: 'dead'});
    expect(first.events()).toEqual([
      expect.objectContaining({type: 'approval.resolved', requestId: 'a-open', decision: 'deny', source: 'process_exit'}),
      expect.objectContaining({type: 'question.resolved', requestId: 'q-open', outcome: 'cancelled', reason: 'process_exit'}),
      expect.objectContaining({type: 'usage', turn: null}),
      expect.objectContaining({type: 'turn.stop_unconfirmed', turnId: 't1'}),
    ]);
    await first.send({type: 'initialize', protocolVersion: 1});
    expect(await first.send({type: 'approval.respond', requestId: 'a-open', decision: 'allow'}))
      .toMatchObject({ok: true, status: 'already_resolved', decision: 'deny', source: 'process_exit'});
    expect(await first.send({type: 'approval.respond', requestId: 'a-old', decision: 'deny'}))
      .toMatchObject({ok: true, status: 'already_resolved', decision: 'allow', source: 'client'});
    expect(await first.send({type: 'question.answer', requestId: 'q-open', answer: 'late'}))
      .toMatchObject({ok: true, status: 'already_resolved', outcome: 'cancelled'});
    await first.send({type: 'shutdown'});
    // The resolutions are in the log: a later resume emits nothing new and still answers.
    const second = await harness({root, session: 'dead'});
    expect(second.events()).toHaveLength(0);
    await second.send({type: 'initialize', protocolVersion: 1});
    expect(await second.send({type: 'approval.respond', requestId: 'a-open', decision: 'allow'}))
      .toMatchObject({status: 'already_resolved', source: 'process_exit'});
    await second.send({type: 'shutdown'});
  });

  test('the line reader decodes a multi-byte character split across chunks and limits bytes', async () => {
    const h = await harness();
    const input = new PassThrough();
    const served = serveLines(h.server, input);
    input.write(`${JSON.stringify({id: 1, type: 'initialize', protocolVersion: 1})}\n`);
    const line = Buffer.from(`${JSON.stringify({id: 2, type: 'prompt', input: 'say €uro ✓'})}\n`, 'utf8');
    const euro = line.indexOf(Buffer.from('€', 'utf8'));
    input.write(line.subarray(0, euro + 1));
    input.write(line.subarray(euro + 1, euro + 2));
    input.write(line.subarray(euro + 2));
    await h.waitFor(event => event.type === 'turn.completed');
    expect(h.events().find(event => event.type === 'turn.completed')!.text).toBe('€uro ✓');
    // 600k two-byte characters: under the limit in characters, over it in bytes.
    input.write(`${JSON.stringify({id: 3, type: 'prompt', input: 'é'.repeat(600_000)})}\n`);
    await h.waitFor(event => event.type === 'response' && event.error?.code === 'line_too_long');
    input.end();
    expect(await served).toBe(0);
  });

  test('reopening a log syncs file and directory before any recovered record is durable or replayed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-server-'));
    roots.push(root);
    const leaseStore = (dir: string) => new JsonlSessionEventStore({rootDir: dir});
    const first = new WireEventLog({rootDir: root, session: 'reopen', leaseStore});
    const ts = new Date().toISOString();
    // Appended by a process that died before its scheduled fsync.
    first.append({schemaVersion: 1, seq: 1, session: 'reopen', ts, type: 'status', status: 'x'});
    first.append({schemaVersion: 1, seq: 2, session: 'reopen', ts, type: 'status', status: 'y'});
    first.close();
    const order: string[] = [];
    const log = new WireEventLog({rootDir: root, session: 'reopen', leaseStore,
      syncFile: () => { order.push('file'); }, syncDirectory: () => { order.push('dir'); }});
    expect(order).toEqual(['file', 'dir']);
    expect(log.durableSeq).toBe(2);
    log.close();
    // A failing reopen sync exposes nothing: the log does not open.
    expect(() => new WireEventLog({rootDir: root, session: 'reopen', leaseStore, syncFile: () => { throw new Error('EIO'); }})).toThrow('EIO');
  });

  test('Codex usage is partial when the turn did not complete normally', async () => {
    const h = await harness({engine: 'codex'});
    await h.send({type: 'initialize', protocolVersion: 1});
    await h.send({type: 'prompt', input: 'codex usage'});
    expect(await h.waitFor(line => line.type === 'usage')).toMatchObject({complete: true});
    await h.waitFor(line => line.type === 'turn.completed');
    const turn = await h.send({type: 'prompt', input: 'codex usage then unconfirmed'});
    await h.waitFor(line => line.type === 'turn.started' && line.turnId === turn.turnId);
    await h.send({type: 'cancel'});
    await h.waitFor(line => line.type === 'turn.stop_unconfirmed');
    expect(h.events().filter(event => event.type === 'usage')[1]).toMatchObject({turn: {requests: 1, totalTokens: 8}, complete: false});
    expect((await h.send({type: 'usage'})).usage).toMatchObject({complete: false, session: {requests: 3, totalTokens: 43}});
    await h.send({type: 'shutdown'});
  });
});
