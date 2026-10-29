import {createServer, type Server} from 'node:http';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {GO_LINE, launch, READY_LINE} from './attemptLauncher.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
  server = undefined;
});

async function relay(nonce: string): Promise<string> {
  server = createServer((_request, response) => { response.writeHead(200); response.end(JSON.stringify({nonce})); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as {port: number}).port}/sift/v1/diagnostic`;
}

describe('launch', () => {
  it('proves the relay, says ready, waits for go, then runs the workload and returns its exit code', async () => {
    const url = await relay('n-1');
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const exit = launch({SIFT_DIAGNOSTIC_URL: url, SIFT_DIAGNOSTIC_NONCE: 'n-1', PATH: process.env.PATH}, ['sh', '-c', 'exit 3'], {input, output});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines.join('')).toBe(`${READY_LINE}\n`);
    input.write(`${GO_LINE}\n`);
    expect(await exit).toBe(3);
  });

  it('never starts the workload without the supervisor\'s nonce, or when stdin closes before go', async () => {
    const wrong = await relay('someone-else');
    expect(await launch({SIFT_DIAGNOSTIC_URL: wrong, SIFT_DIAGNOSTIC_NONCE: 'n-1'}, ['sh', '-c', 'exit 0'],
      {input: new PassThrough(), output: new PassThrough()})).toBe(70);
    await new Promise((resolve) => server!.close(resolve));
    const url = await relay('n-1');
    const input = new PassThrough();
    const exit = launch({SIFT_DIAGNOSTIC_URL: url, SIFT_DIAGNOSTIC_NONCE: 'n-1'}, ['sh', '-c', 'exit 0'], {input, output: new PassThrough()});
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.end();
    expect(await exit).toBe(71);
  });
});
