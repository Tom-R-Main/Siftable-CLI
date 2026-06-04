/**
 * A fake `codex app-server` child process for testing the CodexClient JSON-RPC
 * plumbing without spawning a real binary. Models just enough of a
 * ChildProcessByStdio to satisfy the client: piped stdin/stdout, the `error`/
 * `exit` events, and `kill()`.
 *
 * The fake records every JSON-RPC message the client writes to stdin (`sent`)
 * and exposes server→client helpers (reply / notify / serverRequest / exit) so
 * tests can drive the wire protocol deterministically.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CodexSpawnFn } from '../../interactive-tui/codexEngine';

export class FakeCodexProc extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;
  /** JSON-RPC messages the client has written to stdin, parsed and framed. */
  readonly sent: Array<Record<string, unknown>> = [];
  private rawIn = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.rawIn += chunk.toString();
      let nl: number;
      while ((nl = this.rawIn.indexOf('\n')) >= 0) {
        const line = this.rawIn.slice(0, nl);
        this.rawIn = this.rawIn.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          this.sent.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* mirror the client: ignore non-JSON */
        }
      }
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  /** Construct a spawn seam that hands this fake to a CodexClient. */
  asSpawnFn(): CodexSpawnFn {
    return () => this as unknown as ReturnType<CodexSpawnFn>;
  }

  // ── server → client drivers ────────────────────────────────────────────────
  /** Write a raw string to stdout — use to split a message across chunks. */
  writeRaw(s: string): void {
    this.stdout.write(s);
  }

  /** Emit one newline-framed JSON message from the server. */
  emitMessage(obj: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }

  reply(id: number | string, result: Record<string, unknown>): void {
    this.emitMessage({ jsonrpc: '2.0', id, result });
  }

  replyError(id: number | string, message: string, code = -32000): void {
    this.emitMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Push a server → client notification (no id). */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.emitMessage({ jsonrpc: '2.0', method, params });
  }

  /** Push a server → client request (e.g. an approval), expecting a response. */
  serverRequest(id: number | string, method: string, params: Record<string, unknown> = {}): void {
    this.emitMessage({ jsonrpc: '2.0', id, method, params });
  }

  /** Simulate the process exiting. */
  exit(code = 0): void {
    this.emit('exit', code, null);
  }

  /** Simulate a spawn/runtime error (ENOENT etc.). */
  fail(err: Error): void {
    this.emit('error', err);
  }
}

async function poll<T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Resolve once the client has written a request for `method`; returns its id. */
export async function waitForSent(proc: FakeCodexProc, method: string, timeoutMs = 1000): Promise<number> {
  const found = await poll(() => proc.sent.find((m) => m.method === method), timeoutMs);
  if (!found) throw new Error(`timed out waiting for "${method}" to be written to stdin`);
  return found.id as number;
}

/** Resolve once a written message matches `predicate` (e.g. a response by id). */
export async function waitForSentWhere(
  proc: FakeCodexProc,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  const found = await poll(() => proc.sent.find(predicate), timeoutMs);
  if (!found) throw new Error('timed out waiting for a matching message on stdin');
  return found;
}

/** Drive the initialize → initialized handshake so ensureReady() resolves. */
export async function completeHandshake(proc: FakeCodexProc): Promise<void> {
  const id = await waitForSent(proc, 'initialize');
  proc.reply(id, { capabilities: {} });
  await waitForSent(proc, 'initialized'); // the client's post-init notification
}
