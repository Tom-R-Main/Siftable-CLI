import {connect, createServer, type AddressInfo, type Server, type Socket} from 'node:net';
import type {Server as HttpServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import {isForbiddenAddress, type ProxyOptions, REGISTRY_HOST, startRegistryProxy} from './registryProxy.js';

const PUBLIC = '104.16.0.35';
let servers: Array<Server | HttpServer> = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve(undefined)))));
  servers = [];
});

/** A stand-in for the registry: echoes whatever arrives through the tunnel. */
async function echo(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A proxy whose tunnels reach the local echo server instead of the internet, resolving the registry as told. */
async function proxy(answers: string[], options: Partial<ProxyOptions> = {}) {
  const echoPort = await echo();
  const opened: string[] = [];
  const server = await startRegistryProxy({port: 0, resolve: async () => answers,
    open: (address) => { opened.push(address); return connect(echoPort, '127.0.0.1'); }, ...options});
  servers.push(server);
  return {port: (server.address() as AddressInfo).port, opened};
}

/** Sends a CONNECT and returns the status line, plus the socket for the tunnel. */
function request(port: number, target: string, method = 'CONNECT'): Promise<{status: string; socket: Socket}> {
  return new Promise((resolve, rejected) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString();
      if (head.includes('\r\n\r\n')) { socket.off('data', onData); resolve({status: head.split('\r\n')[0], socket}); }
    };
    socket.on('data', onData);
    socket.once('error', rejected);
  });
}

const roundTrip = (socket: Socket, text: string) => new Promise<string>((resolve) => {
  socket.once('data', (chunk) => resolve(chunk.toString()));
  socket.write(text);
});

describe('registry proxy', () => {
  it('tunnels to the registry at the address it checked, passing bytes through untouched', async () => {
    const {port, opened} = await proxy([PUBLIC]);
    const {status, socket} = await request(port, `${REGISTRY_HOST}:443`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    expect(await roundTrip(socket, '\x16\x03\x01 client hello')).toBe('\x16\x03\x01 client hello');
    expect(opened).toEqual([PUBLIC]);
    socket.destroy();
  });

  it('refuses every other host, port, address form and method', async () => {
    const {port, opened} = await proxy([PUBLIC]);
    for (const target of ['evil.example:443', `${REGISTRY_HOST}:80`, `${REGISTRY_HOST}:8443`, `${PUBLIC}:443`, '[::1]:443',
      `${REGISTRY_HOST}.evil.example:443`, `${REGISTRY_HOST}`]) {
      const {status, socket} = await request(port, target);
      expect(status, target).toBe('HTTP/1.1 403 Forbidden');
      socket.destroy();
    }
    const plain = await request(port, `http://${REGISTRY_HOST}/left-pad`, 'GET');
    expect(plain.status).toMatch(/^HTTP\/1.1 405/);
    plain.socket.destroy();
    expect(opened).toEqual([]);
  });

  it('refuses the tunnel when the registry resolves to any address it must never reach', async () => {
    for (const answers of [['127.0.0.1'], ['169.254.169.254'], ['10.0.0.5'], ['172.17.0.1'], ['192.168.1.1'], ['100.64.0.1'], ['::1'],
      ['fd00::1'], ['fe80::1'], ['::ffff:127.0.0.1'], [PUBLIC, '10.0.0.5'], ['203.0.113.10'], [], ['192.0.2.1']]) {
      const {port, opened} = await proxy(answers);
      const {status, socket} = await request(port, `${REGISTRY_HOST}:443`);
      expect(status, answers.join(',')).toBe('HTTP/1.1 403 Forbidden');
      expect(opened).toEqual([]);
      socket.destroy();
    }
    // The host's own public address is refused too.
    const {port} = await proxy([PUBLIC], {hostAddresses: [PUBLIC]});
    expect((await request(port, `${REGISTRY_HOST}:443`)).status).toBe('HTTP/1.1 403 Forbidden');
  });

  it('closes every tunnel once the byte cap is passed', async () => {
    const {port} = await proxy([PUBLIC], {maxBytes: 64});
    const {socket} = await request(port, `${REGISTRY_HOST}:443`);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write('x'.repeat(200));
    await closed;
  });

  it('refuses tunnels past the concurrency cap', async () => {
    const {port} = await proxy([PUBLIC], {maxTunnels: 1});
    const first = await request(port, `${REGISTRY_HOST}:443`);
    expect(first.status).toBe('HTTP/1.1 200 Connection Established');
    const second = await request(port, `${REGISTRY_HOST}:443`);
    expect(second.status).toBe('HTTP/1.1 429 Too Many Tunnels');
    first.socket.destroy();
    second.socket.destroy();
  });

  it('classifies addresses by range, mapped forms included', () => {
    expect(isForbiddenAddress('8.8.8.8')).toBe(false);
    expect(isForbiddenAddress('2606:4700::6810:84e5')).toBe(false);
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false);
    for (const address of ['0.0.0.0', '127.255.255.255', '224.0.0.1', '255.255.255.255', '::', '::ffff:10.1.2.3', '::ffff:7f00:1',
      'ff02::1', 'not-an-ip']) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });
});
