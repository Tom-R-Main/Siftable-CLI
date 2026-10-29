/**
 * The agent container's entrypoint (first-run U2d-2), run with the image's
 * node from a read-only mount. It holds the workload behind the supervisor's
 * barrier: first it proves the path to the relay by fetching the diagnostic
 * route and checking the supervisor's nonce, then prints `ready` and waits
 * for `go` on stdin. Only then does it start the workload, which inherits
 * stdout and stderr; its exit code becomes the container's. Self-contained:
 * Node built-ins only.
 */
import {spawn} from 'node:child_process';
import {get} from 'node:http';

export const READY_LINE = 'sift-ready';
export const GO_LINE = 'sift-go';

function fetchNonce(url: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = get(url, {timeout: timeoutMs}, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
      response.once('error', () => resolve(undefined));
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 ? String((JSON.parse(body) as {nonce?: unknown}).nonce) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(undefined); });
    request.on('error', () => resolve(undefined));
  });
}

/** Resolves true on `go`, false when stdin closes first. */
function waitForGo(input: NodeJS.ReadableStream): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = '';
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.split('\n').includes(GO_LINE)) resolve(true);
    });
    input.once('end', () => resolve(false));
  });
}

/**
 * The supervisor starts the sidecar just before this container, so its relay
 * may not be listening yet. Retry until the nonce matches or the time is up.
 */
async function awaitRelay(url: string, expected: string | undefined, timeoutMs: number, retryMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const nonce = await fetchNonce(url, left);
    if (nonce && nonce === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, Math.max(0, deadline - Date.now()))));
  }
}

export async function launch(env: NodeJS.ProcessEnv, argv: string[], io = {input: process.stdin, output: process.stdout},
  timing = {relayTimeoutMs: 10_000, retryMs: 100}): Promise<number> {
  if (!env.SIFT_DIAGNOSTIC_NONCE) return 70;
  if (!await awaitRelay(env.SIFT_DIAGNOSTIC_URL ?? '', env.SIFT_DIAGNOSTIC_NONCE, timing.relayTimeoutMs, timing.retryMs)) return 70;
  io.output.write(`${READY_LINE}\n`);
  if (!await waitForGo(io.input)) return 71;
  const [command, ...args] = argv;
  if (!command) return 72;
  const child = spawn(command, args, {stdio: ['ignore', 'inherit', 'inherit'], env: {...env, SIFT_DIAGNOSTIC_NONCE: ''}});
  return new Promise((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

if (require.main === module) {
  launch(process.env, process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
