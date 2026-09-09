import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createChatAgent} from '../agent-harness';
import {InMemorySessionEventStore, SessionKernel, type SessionEventStore} from '../agent-harness/framework/session';
import {verifyCandidate, verifyReceiptCurrent, type CandidateVerificationInput, type CandidateVerificationReceipt} from '../candidateVerification';

async function fixture(run: (input: CandidateVerificationInput, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-verification-integration-')));
  await writeFile(join(root, 'candidate.txt'), 'candidate');
  const input: CandidateVerificationInput = {
    argv: ['/bin/sh', '-c', 'exit 0'], files: ['candidate.txt'],
    context: {sessionId: 'verification-fixture', turnId: 'verify-turn', callId: 'verify-call',
      workspaceRoot: root, sessionCwd: root, approval: {policy: 'allow', scopeId: 'explicit-check'}},
  };
  try { await run(input, root); } finally { await rm(root, {recursive: true, force: true}); }
}

function agentFor(store: SessionEventStore = new InMemorySessionEventStore()) {
  return createChatAgent({adapter: {name: 'fixture', model: 'fixture', chat: async () => ({text: 'done'})},
    memory: false, tools: [], session: {id: 'verification-fixture', store}});
}

describe('verification execution and journal integration', () => {
  test('known failed checks cannot claim passed', async () => fixture(async (input) => {
    const agent = await agentFor();
    try {
      const receipt = await agent.runVerification({...input, argv: ['/bin/sh', '-c', 'printf failed; exit 1']});
      expect(receipt.status).toBe('failed');
      expect(receipt.exitCode).toBe(1);
      expect(receipt.stdout).toBe('failed');
      expect(agent.getSessionEvents().filter(event => event.type.startsWith('verification/')).map(event => event.type)).toEqual(['verification/started', 'verification/recorded']);
    } finally { await agent.close(); }
  }));

  test('changes during a successful check are stale and later edits invalidate historical passes', async () => fixture(async (input, root) => {
    const stale = await verifyCandidate({...input, argv: ['/bin/sh', '-c', 'printf changed > candidate.txt']});
    expect(stale.status).toBe('stale');
    const passed = await verifyCandidate(input);
    expect(passed.status).toBe('passed');
    expect(verifyReceiptCurrent(passed).current).toBe(true);
    await writeFile(join(root, 'candidate.txt'), 'external edit');
    expect(verifyReceiptCurrent(passed)).toEqual({current: false, reason: 'candidate_changed_since_check'});
  }));

  test('a zero-exit checker with unfinished background work cannot pass', async () => fixture(async (input) => {
    const receipt = await verifyCandidate({...input, argv: ['/bin/sh', '-c', 'sleep 30 >/dev/null 2>&1 & exit 0']});
    expect(receipt.exitCode).toBe(0);
    expect(receipt.terminationConfirmed).toBe(true);
    expect(receipt.status).toBe('unknown');
  }));

  test('journal failure before dispatch prevents checker effects', async () => fixture(async (input, root) => {
    const backing = new InMemorySessionEventStore();
    const store: SessionEventStore = {
      read: (id) => backing.read(id),
      append: (event) => {
        if (event.type === 'verification/started') throw new Error('fixture journal unavailable');
        backing.append(event);
      },
    };
    const agent = await agentFor(store);
    try {
      await expect(agent.runVerification({...input, argv: ['/bin/sh', '-c', 'printf touched > marker.txt']})).rejects.toThrow('journal unavailable');
      await expect(readFile(join(root, 'marker.txt'))).rejects.toThrow();
      expect(backing.read('verification-fixture').some(event => event.type.startsWith('verification/'))).toBe(false);
    } finally { await agent.close(); }
  }));

  test('crash after a prepared receipt recovers unknown once and never executes the command', async () => fixture(async (input, root) => {
    let prepared: CandidateVerificationReceipt | undefined;
    await expect(verifyCandidate({...input, argv: ['/bin/sh', '-c', 'printf touched > marker.txt'], onPrepared: (receipt) => {
      prepared = receipt; throw new Error('simulated crash before dispatch');
    }})).rejects.toThrow('simulated crash');
    const store = new InMemorySessionEventStore();
    const before = new SessionKernel({sessionId: input.context.sessionId, store});
    before.append({type: 'verification/started', data: {receipt: prepared!}});
    const recovered = new SessionKernel({sessionId: input.context.sessionId, store});
    recovered.recoverInterrupted();
    const receipts = recovered.getEvents().filter(event => event.type === 'verification/recorded');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].data.receipt).toMatchObject({status: 'unknown', terminationConfirmed: false});
    expect(recovered.recoverInterrupted()).toHaveLength(0);
    await expect(readFile(join(root, 'marker.txt'))).rejects.toThrow();
  }));

  test('close waits for admitted verification to stop and durably records interruption', async () => fixture(async (input, root) => {
    const agent = await agentFor();
    const controller = new AbortController();
    const checking = agent.runVerification({...input, argv: ['/bin/sh', '-c', 'printf started > started.txt; sleep 30'], context: {...input.context, signal: controller.signal}});
    // Wait for an actual checker effect, not an assumed scheduler delay.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(join(root, 'started.txt')); break; } catch { await Bun.sleep(5); }
    }
    expect(await readFile(join(root, 'started.txt'), 'utf8')).toBe('started');
    let closed = false;
    const closing = agent.close().then(() => { closed = true; });
    await Bun.sleep(5);
    expect(closed).toBe(false);
    controller.abort();
    const receipt = await checking;
    await closing;
    expect(receipt.status).toBe('interrupted');
    expect(closed).toBe(true);
    expect(agent.getSessionEvents().at(-1)?.type).toBe('verification/recorded');
  }));

  test('the journal rejects a passed receipt whose candidate contents do not match its digest', async () => fixture(async (input) => {
    const receipt = await verifyCandidate(input);
    expect(receipt.status).toBe('passed');
    const corrupted = structuredClone(receipt);
    corrupted.after!.files[0].sha256 = '0'.repeat(64);
    const session = new SessionKernel({sessionId: input.context.sessionId});
    expect(() => session.append({type: 'verification/recorded', data: {receipt: corrupted}})).toThrow();
  }));

  test('headless verification failure exits nonzero and is visible in JSON and text output', async () => fixture(async (_input, root) => {
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as {model: string};
      return Response.json({id: 'reply', model: body.model, choices: [{index: 0, message: {role: 'assistant', content: 'Model turn complete.'}, finish_reason: 'stop'}], usage: {prompt_tokens: 2, completion_tokens: 3}});
    }});
    try {
      for (const format of ['json', 'text']) {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../headless.ts'), '--provider', 'meta', '--model', 'fixture',
          '--base-url', `http://127.0.0.1:${server.port}/v1`, '--prompt', 'Answer briefly', '--cwd', root,
          '--session', `check-${format}`, '--approval', 'allow', '--format', format, '--max-rounds', '1',
          '--verify-command', JSON.stringify(['/bin/sh', '-c', 'exit 1']), '--verify-file', 'candidate.txt'], {
          cwd: root, env: {PATH: process.env.PATH, HOME: root, META_API_KEY: 'fixture-key', SIFT_EXPLORER_MODE: 'off',
            SIFT_CONTEXT_COMPACTION: '0', SIFT_SESSION_EVENT_ROOT: join(root, 'events')}, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(1);
        if (format === 'json') {
          const terminal = JSON.parse(stdout);
          expect(terminal.status).toBe('limit_reached');
          expect(terminal.verification.status).toBe('failed');
        } else {
          expect(`${stdout}\n${stderr}`).toMatch(/verification[^\n]*failed/i);
        }
      }
    } finally { server.stop(true); }
  }));
});
