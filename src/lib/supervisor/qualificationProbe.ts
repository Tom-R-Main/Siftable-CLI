/**
 * Isolation probes, run inside the agent container by `sift machine qualify`
 * (first-run U2d-1). Self-contained: Node built-ins only, because it runs
 * with the agent image's node from a read-only mount. It prints one JSON line
 * of outcomes and allowlisted codes, and never reports what it read.
 *
 * A probe that could not tell is `error`, never `blocked`. In particular a
 * name that does not resolve proves nothing: only literal-address attempts
 * can show that the network has no way out.
 */
import {promises as fs} from 'node:fs';
import {get} from 'node:http';
import {connect} from 'node:net';

type Outcome = 'blocked' | 'reached' | 'error';
type Code = 'ok' | 'permission_denied' | 'not_found' | 'connection_refused' | 'timeout'
  | 'network_unreachable' | 'read_succeeded' | 'connect_succeeded' | 'unexpected_error';
export interface ProbeResult {outcome: Outcome; code: Code}

export interface ProbeConfig {
  credentialPaths: string[];
  dockerSockets: string[];
  /** Names count only if reached; they never establish blocking. */
  providerNames: Array<{host: string; port: number}>;
  /** Literal addresses: a public IP, the network gateway, the cloud metadata service. */
  escapeAddresses: Array<{host: string; port: number}>;
  procRoot: string;
  diagnosticUrl: string;
  diagnosticNonce: string;
  timeoutMs: number;
}

const HOST_PROCESSES = new Set(['dockerd', 'containerd', 'systemd', 'sshd', 'kthreadd', 'init', 'containerd-shim', 'runc']);

function errnoOf(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code ?? '');
}

/** One verdict from several attempts: any reached wins; then any error; else blocked. */
function combine(results: ProbeResult[]): ProbeResult {
  return results.find((result) => result.outcome === 'reached')
    ?? results.find((result) => result.outcome === 'error')
    ?? results[0]
    ?? {outcome: 'error', code: 'unexpected_error'};
}

export async function probeRead(paths: string[]): Promise<ProbeResult> {
  const results: ProbeResult[] = [];
  for (const target of paths) {
    try {
      const handle = await fs.open(target, 'r');
      await handle.close();
      results.push({outcome: 'reached', code: 'read_succeeded'});
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') results.push({outcome: 'blocked', code: 'not_found'});
      else if (code === 'EACCES' || code === 'EPERM') results.push({outcome: 'blocked', code: 'permission_denied'});
      else results.push({outcome: 'error', code: 'unexpected_error'});
    }
  }
  return combine(results);
}

function attemptConnect(options: {host?: string; port?: number; path?: string}, timeoutMs: number): Promise<ProbeResult | 'unresolved'> {
  return new Promise((resolve) => {
    const socket = connect(options as never);
    const done = (result: ProbeResult | 'unresolved') => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done({outcome: 'blocked', code: 'timeout'}));
    socket.once('connect', () => done({outcome: 'reached', code: 'connect_succeeded'}));
    socket.once('error', (error) => {
      const code = errnoOf(error);
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') done('unresolved');
      else if (code === 'ENOENT') done({outcome: 'blocked', code: 'not_found'});
      else if (code === 'EACCES' || code === 'EPERM') done({outcome: 'blocked', code: 'permission_denied'});
      else if (code === 'ECONNREFUSED') done({outcome: 'blocked', code: 'connection_refused'});
      else if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') done({outcome: 'blocked', code: 'network_unreachable'});
      else if (code === 'ETIMEDOUT') done({outcome: 'blocked', code: 'timeout'});
      else done({outcome: 'error', code: 'unexpected_error'});
    });
  });
}

export async function probeDockerSocket(paths: string[], timeoutMs: number): Promise<ProbeResult> {
  const results: ProbeResult[] = [];
  for (const path of paths) {
    const result = await attemptConnect({path}, timeoutMs);
    results.push(result === 'unresolved' ? {outcome: 'error', code: 'unexpected_error'} : result);
  }
  return combine(results);
}

export async function probeEgress(config: Pick<ProbeConfig, 'providerNames' | 'escapeAddresses' | 'timeoutMs'>): Promise<ProbeResult> {
  for (const target of config.providerNames) {
    const result = await attemptConnect(target, config.timeoutMs);
    if (result !== 'unresolved' && result.outcome === 'reached') return result;
  }
  if (config.escapeAddresses.length === 0) return {outcome: 'error', code: 'unexpected_error'};
  const results: ProbeResult[] = [];
  for (const target of config.escapeAddresses) {
    const result = await attemptConnect(target, config.timeoutMs);
    // A literal address never needs resolving; an unresolved one means the probe itself is wrong.
    results.push(result === 'unresolved' ? {outcome: 'error', code: 'unexpected_error'} : result);
  }
  return combine(results);
}

/** Host processes visible in /proc mean a shared PID namespace. The host inspect checks the PID mode too. */
export async function probeHostProcesses(procRoot: string): Promise<ProbeResult> {
  let entries: string[];
  try {
    entries = (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  } catch {
    return {outcome: 'error', code: 'unexpected_error'};
  }
  if (entries.length === 0) return {outcome: 'error', code: 'unexpected_error'};
  for (const pid of entries) {
    let comm: string;
    try {
      comm = (await fs.readFile(`${procRoot}/${pid}/comm`, 'utf8')).trim();
    } catch {
      continue;
    }
    if (HOST_PROCESSES.has(comm)) return {outcome: 'reached', code: 'read_succeeded'};
  }
  return {outcome: 'blocked', code: 'ok'};
}

/** The relay is reached only when the supervisor's own nonce comes back through the sidecar. */
export function probeRelay(url: string, nonce: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const request = get(url, {timeout: timeoutMs}, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { if (body.length < 4096) body += chunk; });
      response.on('end', () => {
        let echoed: unknown;
        try {
          echoed = (JSON.parse(body) as {nonce?: unknown}).nonce;
        } catch {
          echoed = undefined;
        }
        resolve(response.statusCode === 200 && echoed === nonce
          ? {outcome: 'reached', code: 'ok'} : {outcome: 'error', code: 'unexpected_error'});
      });
    });
    request.on('timeout', () => { request.destroy(); resolve({outcome: 'error', code: 'timeout'}); });
    request.on('error', (error) => {
      const code = errnoOf(error);
      resolve({outcome: 'error', code: code === 'ECONNREFUSED' ? 'connection_refused' : 'unexpected_error'});
    });
  });
}

export async function runProbes(config: ProbeConfig): Promise<Record<string, ProbeResult>> {
  return {
    read_supervisor_credential: await probeRead(config.credentialPaths),
    reach_provider_direct: await probeEgress(config),
    open_docker_socket: await probeDockerSocket(config.dockerSockets, config.timeoutMs),
    see_host_processes: await probeHostProcesses(config.procRoot),
    reach_relay: await probeRelay(config.diagnosticUrl, config.diagnosticNonce, config.timeoutMs),
  };
}

function configFromEnv(env: NodeJS.ProcessEnv): ProbeConfig {
  const targets = (value: string | undefined) => (value ?? '').split(',').filter(Boolean).map((entry) => {
    const at = entry.lastIndexOf(':');
    return {host: entry.slice(0, at), port: Number(entry.slice(at + 1))};
  });
  return {
    credentialPaths: ['/var/lib/siftable-supervisor/credential.json', '/var/lib/siftable-supervisor/enrollment-key.pem', '/var/lib/siftable-supervisor'],
    dockerSockets: ['/var/run/docker.sock', '/run/docker.sock'],
    providerNames: [{host: 'api.anthropic.com', port: 443}, {host: 'api.openai.com', port: 443}],
    escapeAddresses: targets(env.SIFT_PROBE_ESCAPE_ADDRESSES),
    procRoot: '/proc',
    diagnosticUrl: env.SIFT_DIAGNOSTIC_URL ?? '',
    diagnosticNonce: env.SIFT_DIAGNOSTIC_NONCE ?? '',
    timeoutMs: 3000,
  };
}

if (require.main === module) {
  runProbes(configFromEnv(process.env))
    .then((probes) => { process.stdout.write(`${JSON.stringify({probes})}\n`); })
    .catch(() => { process.exitCode = 1; });
}
