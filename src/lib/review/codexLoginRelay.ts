// Loopback model relay for `sift review` (docs/architecture/taster-review.md
// sections 5.4 and 9). The model client always points codex at a relay and
// never gives codex a credential: in the runner the relay leads to the
// controller-side gateway; locally it is this process, which adds the
// credential of the user's own Codex login on the way out.
//
// The credential is read once from $CODEX_HOME/auth.json (default
// ~/.codex/auth.json), held in memory, and never written into the per-call
// CODEX_HOME, logged or printed. The relay never refreshes tokens (a refresh
// rotates them and could sign the user's own codex out); an expired login is
// reported with a hint to run codex. It accepts only POST <base>/responses for
// the one configured model, on 127.0.0.1 at an unguessable path.

import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';

const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export class CodexLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexLoginError';
  }
}

export interface CodexLogin {
  kind: 'chatgpt' | 'api_key';
  upstreamUrl: string;
  /** Request headers carrying the credential. Never logged or returned to codex. */
  headers: Record<string, string>;
  /** Access-token expiry, when the token states one. */
  expiresAt: Date | null;
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(home, 'auth.json');
}

function jwtExpiry(token: string): Date | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {exp?: unknown};
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

const HEADER_VALUE = /^[\x21-\x7e]{8,8192}$/u;

/** Parses the user's Codex login. Throws CodexLoginError with a recovery hint, never with a credential. */
export function parseCodexLogin(text: string, now = new Date()): CodexLogin {
  let auth: unknown;
  try {
    auth = JSON.parse(text);
  } catch {
    throw new CodexLoginError('The Codex login file is not valid JSON. Run `codex login`.');
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new CodexLoginError('The Codex login file is malformed. Run `codex login`.');
  const record = auth as {OPENAI_API_KEY?: unknown; tokens?: unknown};
  const tokens = record.tokens && typeof record.tokens === 'object' && !Array.isArray(record.tokens)
    ? record.tokens as {access_token?: unknown; account_id?: unknown}
    : null;
  if (tokens && typeof tokens.access_token === 'string' && typeof tokens.account_id === 'string') {
    if (!HEADER_VALUE.test(tokens.access_token) || !/^[A-Za-z0-9-]{8,128}$/u.test(tokens.account_id)) {
      throw new CodexLoginError('The Codex login file is malformed. Run `codex login`.');
    }
    const expiresAt = jwtExpiry(tokens.access_token);
    if (expiresAt && expiresAt.getTime() - EXPIRY_MARGIN_MS <= now.getTime()) {
      throw new CodexLoginError('The Codex login token has expired or expires within five minutes. Run any `codex` command (or `codex login`) to refresh it, then retry.');
    }
    return {
      kind: 'chatgpt',
      upstreamUrl: CHATGPT_RESPONSES_URL,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        originator: 'codex_cli_rs',
      },
      expiresAt,
    };
  }
  if (typeof record.OPENAI_API_KEY === 'string' && record.OPENAI_API_KEY) {
    if (!HEADER_VALUE.test(record.OPENAI_API_KEY)) throw new CodexLoginError('The Codex API key is malformed. Run `codex login`.');
    return {kind: 'api_key', upstreamUrl: OPENAI_RESPONSES_URL, headers: {authorization: `Bearer ${record.OPENAI_API_KEY}`}, expiresAt: null};
  }
  throw new CodexLoginError('No usable Codex login was found. Run `codex login`.');
}

export function readCodexLogin(path = codexAuthPath(), now = new Date()): CodexLogin {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CodexLoginError(`No Codex login file at ${path}. Run \`codex login\` (file-based credential storage), or set CODEX_HOME.`);
  }
  return parseCodexLogin(text, now);
}

export interface RelayStats {
  requests: number;
  /** Upstream HTTP status counts, for diagnosis (e.g. 401 means the login was rejected). */
  upstreamStatuses: Record<string, number>;
  refused: number;
}

export interface CodexLoginRelay {
  /** Base URL for codex's provider config, e.g. http://127.0.0.1:PORT/<path>/v1. */
  baseUrl: string;
  stats: RelayStats;
  close(): Promise<void>;
}

export interface RelayOptions {
  login: CodexLogin;
  model: string;
  fetch?: typeof fetch;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolveBody => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
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

function refuse(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify({error: {type: 'sift_review_relay', code}}));
}

/** Starts the relay on 127.0.0.1. */
export async function startCodexLoginRelay(options: RelayOptions): Promise<CodexLoginRelay> {
  const doFetch = options.fetch ?? fetch;
  const prefix = `/${randomBytes(18).toString('base64url')}/v1`;
  const stats: RelayStats = {requests: 0, upstreamStatuses: {}, refused: 0};
  const open = new Set<AbortController>();

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== `${prefix}/responses`) {
      stats.refused += 1;
      refuse(res, 404, 'not_found');
      return;
    }
    void (async () => {
      const body = await readBody(req);
      if (body === null) {
        stats.refused += 1;
        refuse(res, 413, 'request_too_large');
        return;
      }
      let request: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        request = parsed as Record<string, unknown>;
      } catch {
        stats.refused += 1;
        refuse(res, 400, 'invalid_json');
        return;
      }
      if (request.model !== options.model || request.stream !== true) {
        stats.refused += 1;
        refuse(res, 400, 'model_or_stream_not_allowed');
        return;
      }
      // The ChatGPT Codex backend refuses an output cap (the controller gateway
      // strips it in its 'reservation' mode for the same reason).
      const outbound = options.login.kind === 'chatgpt'
        ? (({max_output_tokens: _cap, ...rest}) => rest)(request)
        : request;
      stats.requests += 1;
      const controller = new AbortController();
      open.add(controller);
      res.once('close', () => controller.abort());
      try {
        const upstream = await doFetch(options.login.upstreamUrl, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {...options.login.headers, 'content-type': 'application/json', accept: 'text/event-stream'},
          body: JSON.stringify(outbound),
        });
        const key = String(upstream.status);
        stats.upstreamStatuses[key] = (stats.upstreamStatuses[key] ?? 0) + 1;
        if (!upstream.ok || !upstream.body) {
          // Upstream error bodies are replaced with fixed text.
          await upstream.body?.cancel().catch(() => undefined);
          refuse(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, `upstream_${upstream.status}`);
          return;
        }
        res.writeHead(200, {'content-type': upstream.headers.get('content-type') ?? 'text/event-stream'});
        const reader = upstream.body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise<void>(resolveDrain => res.once('drain', () => resolveDrain()));
        }
        res.end();
      } catch {
        stats.upstreamStatuses.network_error = (stats.upstreamStatuses.network_error ?? 0) + 1;
        if (!res.headersSent) refuse(res, 502, 'upstream_unreachable');
        else res.destroy();
      } finally {
        open.delete(controller);
      }
    })();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const {port} = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    stats,
    close: () =>
      new Promise<void>(resolveClose => {
        for (const controller of open) controller.abort();
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
