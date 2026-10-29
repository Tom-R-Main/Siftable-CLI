/**
 * The supervisor's side of the relay sidecar (first-run U2d-1b): reads
 * request frames from the sidecar's stdout and writes each answer to its
 * stdin. The handler decides every answer; a frame it does not recognise
 * gets 404, and nothing is forwarded anywhere it did not choose.
 */
import {createInterface} from 'node:readline';
import type {SidecarRequestFrame, SidecarResponseFrame} from './relaySidecar.js';

export type SidecarHandler = (frame: SidecarRequestFrame) => Promise<{status: number; body: Buffer | string}>;

const MAX_FRAME_CHARS = 2 * 1024 * 1024;

export function serveSidecarFrames(sidecarStdout: NodeJS.ReadableStream, sidecarStdin: NodeJS.WritableStream, handler: SidecarHandler): void {
  createInterface({input: sidecarStdout}).on('line', (line) => {
    if (line.length > MAX_FRAME_CHARS) return;
    let frame: SidecarRequestFrame;
    try {
      frame = JSON.parse(line) as SidecarRequestFrame;
    } catch {
      return;
    }
    if (typeof frame.id !== 'number' || typeof frame.path !== 'string' || typeof frame.method !== 'string') return;
    void handler(frame)
      .catch(() => ({status: 502, body: ''}))
      .then((answer) => {
        const reply: SidecarResponseFrame = {id: frame.id, status: answer.status, body: Buffer.from(answer.body).toString('base64')};
        sidecarStdin.write(`${JSON.stringify(reply)}\n`);
      });
  });
}

/** Qualification's handler: the diagnostic route answers with the supervisor's nonce, and nothing else exists. */
export function diagnosticHandler(nonce: string, diagnosticPath: string): SidecarHandler {
  return async (frame) => (frame.method === 'GET' && frame.path === diagnosticPath
    ? {status: 200, body: JSON.stringify({nonce})}
    : {status: 404, body: ''});
}
