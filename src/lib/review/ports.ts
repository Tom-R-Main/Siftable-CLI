// Trusted-caller ports for a local review: git, process and the loopback MCP
// endpoint (docs/architecture/taster-review.md section 5.1: the engine and the
// model client never spawn processes or open sockets themselves).

import {spawn} from 'node:child_process';
import {createServer, type IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import type {GitExec, McpEndpointFactory, PrepassOutput, ProcessRunner, ProcessRunResult} from './runtime.js';

const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Process groups started by this module that have not exited yet. */
const activeGroups = new Set<number>();

/**
 * Kills every process group this module started and has not reaped. Called
 * when the review is interrupted (SIGINT/SIGTERM), because the groups are
 * detached and would otherwise outlive the CLI.
 */
export function killActiveProcessGroups(): number {
  let killed = 0;
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Already gone.
    }
  }
  activeGroups.clear();
  return killed;
}

interface CappedResult {
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  stopped: 'aborted' | 'timeout' | null;
}

/**
 * Runs one program without a shell, stdin closed, in its own process group.
 * The group is killed on abort, timeout, stdout overflow and again after the
 * child exits, so nothing it started outlives it. Rejects only when the
 * program could not be started.
 */
function runCapped(request: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}): Promise<CappedResult> {
  return new Promise((resolvePromise, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stopped: CappedResult['stopped'] = null;
    let settled = false;
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: {...request.env},
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) activeGroups.add(child.pid);
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const forget = () => {
      if (child.pid !== undefined) activeGroups.delete(child.pid);
    };
    const stop = (reason: 'aborted' | 'timeout') => {
      stopped ??= reason;
      killGroup();
    };
    const onAbort = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener('abort', onAbort, {once: true});
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutBytes + chunk.length > request.maxStdoutBytes) {
        stdout.push(chunk.subarray(0, request.maxStdoutBytes - stdoutBytes));
        stdoutBytes = request.maxStdoutBytes;
        stdoutTruncated = true;
        killGroup();
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return;
      if (stderrBytes + chunk.length > request.maxStderrBytes) {
        stderr.push(chunk.subarray(0, request.maxStderrBytes - stderrBytes));
        stderrBytes = request.maxStderrBytes;
        stderrTruncated = true;
        return;
      }
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      killGroup();
      forget();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      killGroup();
      forget();
      resolvePromise({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutTruncated,
        stderrTruncated,
        exitCode: code,
        signal,
        stopped,
      });
    });
  });
}

/** ProcessRunner for codex: the request's environment is used exactly. */
export const processRunner: ProcessRunner = async request => {
  const result = await runCapped(request);
  const outcome: ProcessRunResult = {
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    exitCode: result.exitCode,
    signal: result.signal,
    stopped: result.stopped,
  };
  return outcome;
};

const GIT_TIMEOUT_MS = 120_000;
const PREPASS_TIMEOUT_MS = 600_000;

/**
 * Runs the runner's trusted pre-pass (prepass/cli.js from the CLI's packaged
 * copy, never from the checkout) as a tracked child process with its fixed
 * argument vector, so an interrupt can stop it like any other child.
 */
export async function runTrustedPrepassProcess(input: {
  script: string;
  repo: string;
  baseSha: string;
  mergeBase: string;
  head: string;
  ratchetGrowth: string;
  path: string;
  home: string;
}): Promise<PrepassOutput> {
  const result = await runCapped({
    command: process.execPath,
    args: [input.script, '--repo', input.repo, '--base', input.baseSha, '--merge-base', input.mergeBase, '--head', input.head, '--ratchet-growth', input.ratchetGrowth],
    cwd: '/',
    env: {PATH: input.path, HOME: input.home},
    timeoutMs: PREPASS_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.stopped || result.exitCode !== 0 || result.stdoutTruncated) {
    const why = result.stopped ?? (result.stdoutTruncated ? 'output too large' : `exit ${result.exitCode ?? result.signal ?? 'unknown'}`);
    throw new Error(`trusted pre-pass failed (${why}): ${result.stderr.toString('utf8').trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300));
  }
  const parsed = JSON.parse(result.stdout.toString('utf8')) as Partial<PrepassOutput>;
  if (!Array.isArray(parsed.reports) || !Array.isArray(parsed.problems)) throw new Error('trusted pre-pass printed an unexpected result');
  return {reports: parsed.reports, problems: parsed.problems.map(String)};
}

/**
 * GitExec for the engine. The engine passes its hardened git environment
 * (GIT_ENV); this adds only PATH and a HOME that holds no configuration.
 */
export function createGitExec(options: {gitBin: string; path: string; home: string}): GitExec {
  return async (args, opts) => {
    try {
      const result = await runCapped({
        command: options.gitBin,
        args,
        cwd: opts.cwd,
        env: {PATH: options.path, HOME: options.home, ...opts.env},
        timeoutMs: GIT_TIMEOUT_MS,
        maxStdoutBytes: opts.maxBytes,
        maxStderrBytes: 64 * 1024,
      });
      return {
        code: result.stopped || result.exitCode === null ? 1 : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr.toString('utf8'),
        truncated: result.stdoutTruncated,
      };
    } catch (error) {
      return {code: 127, stdout: Buffer.alloc(0), stderr: String((error as Error).message), truncated: false};
    }
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise(resolveBody => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolveBody(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolveBody(Buffer.concat(chunks));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolveBody(null);
      }
    });
  });
}

/**
 * Serves one model call's tool host as a streamable-HTTP MCP endpoint (JSON
 * responses) on 127.0.0.1, at an unguessable path so another local process
 * cannot reach the session by port scanning alone.
 */
export const loopbackMcpEndpoint: McpEndpointFactory = async handle => {
  const path = `/mcp/${randomBytes(24).toString('base64url')}`;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    void readBody(req, MAX_MCP_BODY_BYTES).then(async body => {
      if (body === null) {
        if (!res.headersSent) res.writeHead(413).end();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      let response: unknown;
      try {
        response = await handle(message);
      } catch {
        res.writeHead(500).end();
        return;
      }
      if (response === undefined) res.writeHead(202).end();
      else res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>(resolveClose => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
};
