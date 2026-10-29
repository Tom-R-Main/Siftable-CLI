/**
 * The relay sidecar (first-run U2d-1b). It runs in its own container on the
 * attempt's internal network, the only address the agent can reach. It
 * listens on fixed routes and passes each request, as one line of JSON on
 * stdout, to the supervisor attached to its stdio; the supervisor's answer
 * comes back on stdin. There is no host listener on any network a container
 * can reach. Self-contained: Node built-ins only.
 *
 * U2d-1 forwards only the diagnostic route; U2d-2 adds the model routes.
 */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createInterface} from 'node:readline';

export const SIDECAR_PORT = 8787;
export const DIAGNOSTIC_PATH = '/sift/v1/diagnostic';
const MAX_BODY_BYTES = 1024 * 1024;
const ANSWER_TIMEOUT_MS = 10_000;

export interface SidecarRequestFrame {id: number; method: string; path: string; body: string}
export interface SidecarResponseFrame {id: number; status: number; body: string}

/** The routes the sidecar forwards; anything else is answered 404 here. */
export const SIDECAR_ROUTES: ReadonlyArray<{method: string; path: string}> = [{method: 'GET', path: DIAGNOSTIC_PATH}];

export function startRelaySidecar(io: {input: NodeJS.ReadableStream; output: NodeJS.WritableStream}, port = SIDECAR_PORT) {
  let next = 1;
  const waiting = new Map<number, (frame: SidecarResponseFrame) => void>();
  createInterface({input: io.input}).on('line', (line) => {
    let frame: SidecarResponseFrame;
    try {
      frame = JSON.parse(line) as SidecarResponseFrame;
    } catch {
      return;
    }
    waiting.get(frame.id)?.(frame);
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];
    if (!SIDECAR_ROUTES.some((route) => route.method === request.method && route.path === path)) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        response.writeHead(504).end();
      }, ANSWER_TIMEOUT_MS);
      waiting.set(id, (frame) => {
        clearTimeout(timer);
        waiting.delete(id);
        response.writeHead(frame.status).end(Buffer.from(frame.body, 'base64'));
      });
      const frame: SidecarRequestFrame = {id, method: request.method ?? 'GET', path, body: Buffer.concat(chunks).toString('base64')};
      io.output.write(`${JSON.stringify(frame)}\n`);
    });
  });
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  startRelaySidecar({input: process.stdin, output: process.stdout});
}
