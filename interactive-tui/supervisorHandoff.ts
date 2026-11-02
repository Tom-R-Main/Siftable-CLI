import type { Readable } from 'node:stream';

/** A private inherited pipe is supervisor authority. It must never be forwarded
 * to tool processes, exposed as a writable file, or represented in model input. */
export class SupervisorHandoff {
  private ready = false;
  private settled = false;
  private buffer = '';
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: (error?: Error) => void;
  private readonly outcome = new Promise<Error | undefined>(resolve => { this.resolve = resolve; });

  constructor(
    private readonly input: Readable,
    private readonly identity: {session: string; runId: string},
    private readonly fail: (error: Error) => void,
  ) {
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', this.onError);
    input.once('close', this.onEnd);
    if (input.readableEnded || input.destroyed) this.onEnd();
  }

  private finish(error?: Error, notify = true): void {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.resolve(error);
    if (error && notify) this.fail(error);
  }

  private readonly onEnd = () => this.finish(new Error('Supervisor control pipe closed before release'));
  private readonly onError = () => this.finish(new Error('Supervisor control pipe failed'));
  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += chunk.toString();
    if (Buffer.byteLength(this.buffer) > 4096) return this.finish(new Error('Supervisor control message exceeds 4096 bytes'));
    const newline = this.buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      const message = JSON.parse(this.buffer.slice(0, newline));
      if (!this.ready || this.buffer.slice(newline + 1).trim() || !message || typeof message !== 'object'
        || message.session !== this.identity.session || message.runId !== this.identity.runId
        || !['handoff.release', 'handoff.abort'].includes(message.type)
        || Object.keys(message).some(key => !['type', 'session', 'runId'].includes(key))) {
        throw new Error('Invalid or premature supervisor handoff message');
      }
      this.finish(message.type === 'handoff.abort' ? new Error('Supervisor aborted grading handoff') : undefined);
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error('Invalid supervisor control message'));
    }
  };

  async wait(timeoutMs: number, signal: AbortSignal, emit: (event: Record<string, unknown>) => void): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new Error('Invalid handoff timeout');
    const abort = () => this.finish(new Error('Supervisor handoff interrupted'), false);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    if (!this.settled) {
      this.ready = true;
      const deadlineAt = Date.now() + timeoutMs;
      this.timer = setTimeout(() => this.finish(new Error('Supervisor handoff deadline exceeded')), timeoutMs);
      emit({type: 'handoff.ready', ...this.identity, modelStatus: 'completed', deadlineAt});
    }
    try {
      const error = await this.outcome;
      if (error) throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.dispose();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.input.removeListener('data', this.onData);
    this.input.removeListener('end', this.onEnd);
    this.input.removeListener('close', this.onEnd);
    this.input.removeListener('error', this.onError);
    this.input.pause();
  }
}
