/**
 * The supervisor's side of the relay sidecar (first-run U2d-1b, streams
 * U2d-2): reads request frames from the sidecar's stdout and writes each
 * answer to its stdin. The handler decides every answer; a frame it does not
 * recognise gets 404, and nothing is forwarded anywhere it did not choose.
 *
 * A streamed answer goes out as bounded chunk frames. Each write waits for the
 * sidecar's stdin to drain, so a slow agent slows the upstream read instead of
 * growing a buffer. A `cancel` from the sidecar aborts the handler's signal.
 */
import {createInterface} from 'node:readline';
import type {SidecarCancelFrame, SidecarRequestFrame, SidecarResponseFrame} from './relaySidecar.js';

export type SidecarAnswer =
  | {status: number; body: Buffer | string}
  | {status: number; stream: AsyncIterable<Uint8Array>};
export type SidecarHandler = (frame: SidecarRequestFrame, signal: AbortSignal) => Promise<SidecarAnswer>;

/** A 16 MB body in base64 plus its JSON envelope. */
const MAX_FRAME_CHARS = 23 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function writeFrame(stdin: NodeJS.WritableStream, frame: SidecarResponseFrame): Promise<void> {
  return new Promise((resolve) => {
    if (stdin.write(`${JSON.stringify(frame)}\n`)) resolve();
    else stdin.once('drain', () => resolve());
  });
}

async function answer(stdin: NodeJS.WritableStream, id: number, result: SidecarAnswer, signal: AbortSignal): Promise<void> {
  if ('body' in result) {
    await writeFrame(stdin, {id, status: result.status, body: Buffer.from(result.body).toString('base64')});
    return;
  }
  await writeFrame(stdin, {id, status: result.status, stream: true});
  try {
    for await (const piece of result.stream) {
      if (signal.aborted) return;
      for (let offset = 0; offset < piece.length; offset += CHUNK_BYTES) {
        await writeFrame(stdin, {id, chunk: Buffer.from(piece.subarray(offset, offset + CHUNK_BYTES)).toString('base64')});
      }
    }
    await writeFrame(stdin, {id, end: true});
  } catch {
    if (!signal.aborted) await writeFrame(stdin, {id, error: true});
  }
}

export function serveSidecarFrames(sidecarStdout: NodeJS.ReadableStream, sidecarStdin: NodeJS.WritableStream, handler: SidecarHandler): void {
  const inFlight = new Map<number, AbortController>();
  createInterface({input: sidecarStdout, crlfDelay: Infinity}).on('line', (line) => {
    if (line.length > MAX_FRAME_CHARS) return;
    let frame: SidecarRequestFrame | SidecarCancelFrame;
    try {
      frame = JSON.parse(line) as SidecarRequestFrame | SidecarCancelFrame;
    } catch {
      return;
    }
    if (typeof frame.id !== 'number') return;
    if ('cancel' in frame) {
      inFlight.get(frame.id)?.abort();
      return;
    }
    if (typeof frame.path !== 'string' || typeof frame.method !== 'string' || inFlight.has(frame.id)) return;
    const control = new AbortController();
    inFlight.set(frame.id, control);
    const request = frame;
    void handler(request, control.signal)
      .catch((): SidecarAnswer => ({status: 502, body: ''}))
      .then((result) => answer(sidecarStdin, request.id, result, control.signal))
      .finally(() => inFlight.delete(request.id));
  });
}

/** Qualification's handler: the diagnostic route answers with the supervisor's nonce, and nothing else exists. */
export function diagnosticHandler(nonce: string, diagnosticPath: string): SidecarHandler {
  return async (frame) => (frame.method === 'GET' && frame.path === diagnosticPath
    ? {status: 200, body: JSON.stringify({nonce})}
    : {status: 404, body: ''});
}
