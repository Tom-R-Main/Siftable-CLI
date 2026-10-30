/**
 * The dependency install's only route out (first-run, dependency install
 * contract rev 3), run with the image's node from a read-only mount in a
 * container on two networks: the install helper's internal network and an
 * egress bridge. It accepts one thing, `CONNECT registry.npmjs.org:443`, and
 * passes TLS through untouched: it never sees content and holds no
 * certificate; npm ci checks every tarball against the lockfile's integrity.
 *
 * It resolves the registry itself and refuses the tunnel if any answer is a
 * private, loopback, link-local, shared, documentation, multicast or reserved
 * address, or one of the host's own, so a rebinding answer cannot reach the
 * host or its network. It connects to the address it checked. Caps: bytes
 * across all tunnels, concurrent tunnels, and the proxy's whole lifetime.
 * Self-contained: Node built-ins only.
 */
import {lookup} from 'node:dns/promises';
import {createServer, type IncomingMessage, type Server} from 'node:http';
import {BlockList, connect, isIP, type Socket} from 'node:net';

export const REGISTRY_HOST = 'registry.npmjs.org';
export const PROXY_PORT = 3128;

const forbidden = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  forbidden.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8]] as const) {
  forbidden.addSubnet(network, prefix, 'ipv6');
}

/** True for any address the tunnel must never reach: non-public ranges, IPv4-mapped forms of them, and the host's own. */
export function isForbiddenAddress(address: string, hostAddresses: string[] = []): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (hostAddresses.includes(address)) return true;
  // BlockList also matches IPv4-mapped IPv6 forms (::ffff:127.0.0.1, ::ffff:7f00:1) against the IPv4 ranges.
  return forbidden.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export interface ProxyOptions {
  port?: number;
  resolve?: (host: string) => Promise<string[]>;
  open?: (address: string, port: number) => Socket;
  hostAddresses?: string[];
  maxBytes?: number;
  maxTunnels?: number;
  lifetimeMs?: number;
  log?: (line: string) => void;
}

const reject = (socket: Socket, status: number, reason: string) => {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

/** Starts the proxy; resolves once it listens. Closing it ends every tunnel. */
export function startRegistryProxy(options: ProxyOptions = {}): Promise<Server> {
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, {all: true, verbatim: true})).map((entry) => entry.address));
  const open = options.open ?? ((address: string, port: number) => connect({host: address, port}));
  const maxBytes = options.maxBytes ?? 2 * 1024 ** 3;
  const maxTunnels = options.maxTunnels ?? 64;
  const log = options.log ?? (() => undefined);
  const tunnels = new Set<Socket>();
  // Slots are reserved before any await and released exactly once, so concurrent CONNECTs cannot pass the cap together.
  let slots = 0;
  let transferred = 0;
  const server = createServer((_request, response) => {
    response.writeHead(405, {'Connection': 'close'}).end();
  });
  const closeAll = () => { for (const socket of tunnels) socket.destroy(); };
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    void (async () => {
      const target = request.url ?? '';
      if (target !== `${REGISTRY_HOST}:443`) { log(`refused ${target}`); reject(client, 403, 'Forbidden'); return; }
      if (slots >= maxTunnels) { reject(client, 429, 'Too Many Tunnels'); return; }
      slots += 1;
      let released = false;
      const release = () => { if (!released) { released = true; slots -= 1; } };
      const addresses = await resolve(REGISTRY_HOST).catch(() => [] as string[]);
      // Any non-public answer refuses the tunnel: a mixed answer is a rebinding attempt, not a choice to make.
      if (addresses.length === 0 || addresses.some((address) => isForbiddenAddress(address, options.hostAddresses))) {
        log(`refused ${REGISTRY_HOST} -> ${addresses.join(',') || 'nothing'}`);
        release();
        reject(client, 403, 'Forbidden');
        return;
      }
      if (client.destroyed) { release(); return; }
      const upstream = open(addresses[0], 443);
      tunnels.add(client);
      tunnels.add(upstream);
      const count = (chunk: Buffer) => {
        transferred += chunk.length;
        if (transferred > maxBytes) { log('byte cap reached'); closeAll(); }
      };
      const drop = () => { client.destroy(); upstream.destroy(); tunnels.delete(client); tunnels.delete(upstream); release(); };
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) { count(head); upstream.write(head); }
        client.on('data', count);
        upstream.on('data', count);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once('error', drop);
      client.once('error', drop);
      upstream.once('close', drop);
      client.once('close', drop);
    })();
  });
  return new Promise((ready) => {
    server.listen(options.port ?? PROXY_PORT, () => {
      if (options.lifetimeMs) setTimeout(() => { closeAll(); server.close(); }, options.lifetimeMs).unref();
      ready(server);
    });
  });
}

if (require.main === module) {
  const hostAddresses = (process.env.SIFT_DENY_ADDRESSES ?? '').split(',').filter(Boolean);
  void startRegistryProxy({hostAddresses, lifetimeMs: Number(process.env.SIFT_PROXY_LIFETIME_MS ?? 300_000),
    log: (line) => process.stderr.write(`${line}\n`)}).then((server) => {
    server.on('close', () => process.exit(0));
  });
}
