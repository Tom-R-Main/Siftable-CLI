import {promises as fs} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {probeDockerSocket, probeEgress, probeHostProcesses, probeRead, probeRelay} from './qualificationProbe.js';

let dir: string;
const servers: Array<{close: (cb?: () => void) => unknown}> = [];
const listen = (server: Server, target: number | string) => new Promise<void>((resolve) => server.listen(target, () => resolve()));

beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-probe-')); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
  await fs.rm(dir, {recursive: true, force: true});
});

describe('probeRead', () => {
  it('is blocked when the credential is absent, and reached the moment it can be opened', async () => {
    expect(await probeRead([path.join(dir, 'credential.json')])).toEqual({outcome: 'blocked', code: 'not_found'});
    await fs.writeFile(path.join(dir, 'credential.json'), 'secret');
    expect(await probeRead([path.join(dir, 'missing'), path.join(dir, 'credential.json')]))
      .toEqual({outcome: 'reached', code: 'read_succeeded'});
  });
});

describe('probeDockerSocket', () => {
  it('is blocked without a socket and reached when one accepts', async () => {
    const socketPath = path.join(dir, 'docker.sock');
    expect(await probeDockerSocket([socketPath], 500)).toEqual({outcome: 'blocked', code: 'not_found'});
    const server = createServer((socket) => socket.end());
    servers.push(server);
    await listen(server, socketPath);
    expect(await probeDockerSocket([socketPath], 500)).toEqual({outcome: 'reached', code: 'connect_succeeded'});
  });
});

describe('probeEgress', () => {
  it('never counts an unresolvable name as blocking, and decides on literal addresses', async () => {
    // 192.0.2.1 (TEST-NET-1) never answers: a host address that does not answer is blocked.
    const config = {providerNames: [{host: 'unresolvable.invalid', port: 443}], hostAddresses: [{host: '192.0.2.1', port: 22}], timeoutMs: 300};
    // Names alone, with no literal address to try, prove nothing.
    expect(await probeEgress({...config, escapeAddresses: []})).toEqual({outcome: 'error', code: 'unexpected_error'});
    // A way-out address that refuses is blocked.
    const closed = createServer();
    await listen(closed, 0);
    const port = (closed.address() as {port: number}).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await probeEgress({...config, escapeAddresses: [{host: '127.0.0.1', port}]}))
      .toMatchObject({outcome: 'blocked'});
    // A literal address that accepts is an escape.
    const open = createServer((socket) => socket.end());
    servers.push(open);
    await listen(open, 0);
    expect(await probeEgress({...config, escapeAddresses: [{host: '127.0.0.1', port: (open.address() as {port: number}).port}]}))
      .toEqual({outcome: 'reached', code: 'connect_succeeded'});
  });
});

describe('probeEgress on host addresses', () => {
  it('counts a refusal from a host address as reaching the host', async () => {
    const closed = createServer();
    await listen(closed, 0);
    const port = (closed.address() as {port: number}).port;
    await new Promise((resolve) => closed.close(resolve));
    const config = {providerNames: [], escapeAddresses: [{host: '192.0.2.1', port: 443}], timeoutMs: 300};
    // The same refusal that blocks on a way-out address means the host answered.
    expect(await probeEgress({...config, hostAddresses: [{host: '127.0.0.1', port}]}))
      .toEqual({outcome: 'reached', code: 'connection_refused'});
    expect(await probeEgress({...config, hostAddresses: []})).toEqual({outcome: 'error', code: 'unexpected_error'});
  });
});

describe('probeHostProcesses', () => {
  it('is reached when a host process is visible, blocked for a private namespace, error when unreadable', async () => {
    const proc = path.join(dir, 'proc');
    await fs.mkdir(path.join(proc, '1'), {recursive: true});
    await fs.writeFile(path.join(proc, '1', 'comm'), 'node\n');
    expect(await probeHostProcesses(proc)).toEqual({outcome: 'blocked', code: 'ok'});
    await fs.mkdir(path.join(proc, '812'));
    await fs.writeFile(path.join(proc, '812', 'comm'), 'dockerd\n');
    expect(await probeHostProcesses(proc)).toEqual({outcome: 'reached', code: 'read_succeeded'});
    expect(await probeHostProcesses(path.join(dir, 'nope'))).toEqual({outcome: 'error', code: 'unexpected_error'});
  });

  it('is inconclusive when process names cannot be read, and skips processes that exited', async () => {
    const proc = path.join(dir, 'proc');
    await fs.mkdir(path.join(proc, '7'), {recursive: true});
    // No readable comm at all: nothing was observed, so nothing is blocked.
    expect(await probeHostProcesses(proc)).toEqual({outcome: 'error', code: 'unexpected_error'});
    await fs.mkdir(path.join(proc, '1'));
    await fs.writeFile(path.join(proc, '1', 'comm'), 'node\n');
    // PID 7 exited (no comm file); PID 1 was read.
    expect(await probeHostProcesses(proc)).toEqual({outcome: 'blocked', code: 'ok'});
    // A comm that exists but cannot be read hides a name.
    await fs.mkdir(path.join(proc, '9', 'comm'), {recursive: true});
    expect(await probeHostProcesses(proc)).toEqual({outcome: 'error', code: 'unexpected_error'});
  });
});

describe('probeRelay', () => {
  it('is reached only when the supervisor\'s nonce comes back', async () => {
    let reply = JSON.stringify({nonce: 'expected-nonce'});
    const server = createHttpServer((_request, response) => { response.writeHead(200); response.end(reply); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/sift/v1/diagnostic`;
    expect(await probeRelay(url, 'expected-nonce', 1000)).toEqual({outcome: 'reached', code: 'ok'});
    reply = JSON.stringify({ok: true});
    expect(await probeRelay(url, 'expected-nonce', 1000)).toEqual({outcome: 'error', code: 'unexpected_error'});
    expect(await probeRelay('http://127.0.0.1:1/sift/v1/diagnostic', 'expected-nonce', 1000))
      .toEqual({outcome: 'error', code: 'connection_refused'});
  });

  it('settles as an error when the response is cut off mid-body', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, {'content-length': '100'});
      response.write('{"nonce":"expe');
      setTimeout(() => response.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as {port: number}).port}/sift/v1/diagnostic`;
    expect(await probeRelay(url, 'expected-nonce', 2000)).toEqual({outcome: 'error', code: 'unexpected_error'});
  });
});
