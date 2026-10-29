/**
 * The relay sidecar (first-run U2d-1b, model routes U2d-2). It runs in its
 * own container on the attempt's internal network, the only address the
 * agent can reach. It listens on fixed routes and passes each request, as one
 * line of JSON on stdout, to the supervisor attached to its stdio; the
 * supervisor's answer comes back on stdin. There is no host listener on any
 * network a container can reach, and no credential in this container.
 * Self-contained: Node built-ins only.
 *
 * An answer is either one whole frame (`body`) or a stream: a head frame
 * (`stream: true`), then `chunk` frames, then `end` or `error`. When the
 * agent's response cannot take more data, the sidecar stops reading stdin
 * until it can, so the supervisor's writes back up instead of buffering here.
 * When the agent disconnects first, the sidecar sends `cancel`.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createInterface} from 'node:readline';

export const SIDECAR_PORT = 8787;
export const DIAGNOSTIC_PATH = '/sift/v1/diagnostic';
export const MODEL_PATHS = {
  anthropic: '/sift/v1/model/anthropic/v1/messages',
  openai: '/sift/v1/model/openai/v1/responses',
} as const;

export interface SidecarRequestFrame {id: number; method: string; path: string; body: string}
export type SidecarResponseFrame =
  | {id: number; status: number; body: string}
  | {id: number; status: number; stream: true}
  | {id: number; chunk: string}
  | {id: number; end: true}
  | {id: number; error: true};
export interface SidecarCancelFrame {id: number; cancel: true}

interface Route {method: string; path: string; maxBodyBytes: number; headTimeoutMs: number}

/** The routes the sidecar forwards; anything else is answered 404 here. */
export const SIDECAR_ROUTES: ReadonlyArray<Route> = [
  {method: 'GET', path: DIAGNOSTIC_PATH, maxBodyBytes: 0, headTimeoutMs: 10_000},
  // The server accepts 16 MB relay bodies; a model's first byte can take minutes.
  {method: 'POST', path: MODEL_PATHS.anthropic, maxBodyBytes: 16 * 1024 * 1024, headTimeoutMs: 600_000},
  {method: 'POST', path: MODEL_PATHS.openai, maxBodyBytes: 16 * 1024 * 1024, headTimeoutMs: 600_000},
];

interface Pending {
  response: ServerResponse;
  timer: NodeJS.Timeout;
  streaming: boolean;
}

export function startRelaySidecar(io: {input: NodeJS.ReadableStream; output: NodeJS.WritableStream}, port = SIDECAR_PORT) {
  let next = 1;
  const pending = new Map<number, Pending>();
  const lines = createInterface({input: io.input});
  const finish = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    pending.delete(id);
    return entry;
  };
  lines.on('line', (line) => {
    let frame: SidecarResponseFrame;
    try {
      frame = JSON.parse(line) as SidecarResponseFrame;
    } catch {
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    if ('body' in frame) {
      finish(frame.id)?.response.writeHead(frame.status).end(Buffer.from(frame.body, 'base64'));
    } else if ('stream' in frame) {
      clearTimeout(entry.timer);
      entry.streaming = true;
      entry.response.writeHead(frame.status, {'content-type': 'text/event-stream', 'cache-control': 'no-store'});
    } else if ('chunk' in frame && entry.streaming) {
      if (!entry.response.write(Buffer.from(frame.chunk, 'base64'))) {
        // Hold the supervisor's stream back until the agent reads.
        lines.pause();
        entry.response.once('drain', () => lines.resume());
        entry.response.once('close', () => lines.resume());
      }
    } else if ('end' in frame) {
      finish(frame.id)?.response.end();
    } else if ('error' in frame) {
      const failed = finish(frame.id);
      if (failed?.streaming) failed.response.destroy();
      else failed?.response.writeHead(502).end();
    }
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];
    const route = SIDECAR_ROUTES.find((candidate) => candidate.method === request.method && candidate.path === path);
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > route.maxBodyBytes) {
        tooLarge = true;
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      const id = next++;
      const timer = setTimeout(() => {
        if (finish(id)) {
          io.output.write(`${JSON.stringify({id, cancel: true} satisfies SidecarCancelFrame)}\n`);
          response.writeHead(504).end();
        }
      }, route.headTimeoutMs);
      pending.set(id, {response, timer, streaming: false});
      response.once('close', () => {
        // The agent went away before the answer finished.
        if (finish(id)) io.output.write(`${JSON.stringify({id, cancel: true} satisfies SidecarCancelFrame)}\n`);
      });
      const frame: SidecarRequestFrame = {id, method: route.method, path, body: Buffer.concat(chunks).toString('base64')};
      io.output.write(`${JSON.stringify(frame)}\n`);
    });
  });
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  startRelaySidecar({input: process.stdin, output: process.stdout});
}
