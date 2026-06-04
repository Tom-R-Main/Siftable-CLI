/**
 * HTTP record/replay cassettes for the model adapters — the "avoid hand-written
 * mocks" answer for provider calls (cf. opencode's http-recorder). Records real
 * provider request/response pairs once, replays them deterministically, and
 * commits them as JSON fixtures that are reviewed and diffed like source.
 *
 *   - Default (replay): serves the committed cassette; the live API is never hit.
 *   - RECORD=1 + real API key: calls the real provider, redacts secrets, writes
 *     the cassette. Refuses to write if a credential leaks into the fixture.
 *
 * Matching is order-based (the Nth request is served by the Nth recorded
 * interaction) with method+URL validation, so reordering requests is caught
 * rather than silently masked. Inject the returned `fetch` as an adapter's
 * `fetchImpl`; inspect `sent` to assert how the adapter built each request.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export interface CassetteInteraction {
  request: {method: string; url: string; headers: Record<string, string>; body: unknown};
  response: {status: number; body: unknown};
}
export interface Cassette {
  interactions: CassetteInteraction[];
}

export interface SentRequest {
  method: string;
  url: string;
  body: unknown;
}

export interface CassetteFetch {
  /** Drop-in for an adapter's `fetchImpl`. */
  fetch: typeof fetch;
  /** Every outgoing request the adapter actually made (for request assertions). */
  sent: SentRequest[];
  /** Persist a recording to disk (record mode only); no-op in replay. */
  save(): void;
}

export class UnsafeCassetteError extends Error {}

const RECORDINGS_DIR = path.join(__dirname, '..', 'fixtures', 'recordings');

/** Headers safe to keep verbatim in a committed cassette; all others redacted. */
const HEADER_ALLOWLIST = new Set(['content-type', 'anthropic-version', 'accept']);

/** Shapes that must never reach a committed fixture. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function cassettePath(name: string): string {
  return path.join(RECORDINGS_DIR, `${name}.json`);
}

function isRecording(): boolean {
  return process.env.RECORD === '1' || process.env.RECORD === 'true';
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = HEADER_ALLOWLIST.has(k) ? v : '[REDACTED]';
  }
  return out;
}

/** Throw if a cassette about to be written contains a credential. */
function assertNoSecrets(cassette: Cassette): void {
  const serialized = JSON.stringify(cassette);
  for (const re of SECRET_PATTERNS) {
    const match = serialized.match(re);
    if (match) throw new UnsafeCassetteError(`refusing to write cassette: secret-like value "${match[0].slice(0, 12)}…"`);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && serialized.includes(value)) {
      throw new UnsafeCassetteError(`refusing to write cassette: contains value of env ${key}`);
    }
  }
}

function syntheticResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({'content-type': 'application/json'}),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => text,
  } as Response;
}

function parseBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function loadCassette(name: string): Cassette {
  const file = cassettePath(name);
  if (!existsSync(file)) {
    throw new Error(
      `cassette "${name}" not found at ${file}.\n` +
        `Record it with: RECORD=1 <PROVIDER>_API_KEY=… npx jest <test>`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Cassette;
}

/**
 * Build a cassette-backed fetch for `name`. In replay mode it serves the
 * committed interactions in order; in record mode it proxies the real `fetch`,
 * redacts, and stages interactions for `save()`.
 */
export function createCassetteFetch(name: string): CassetteFetch {
  const sent: SentRequest[] = [];

  if (isRecording()) {
    const interactions: CassetteInteraction[] = [];
    const recordFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = parseBody(init?.body ?? null);
      sent.push({method, url, body});
      const real = await fetch(input, init);
      const text = await real.text();
      const respBody = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })();
      interactions.push({
        request: {method, url, headers: redactHeaders(headersToObject(init?.headers)), body},
        response: {status: real.status, body: respBody},
      });
      return syntheticResponse(real.status, respBody);
    }) as typeof fetch;

    return {
      fetch: recordFetch,
      sent,
      save() {
        const cassette: Cassette = {interactions};
        assertNoSecrets(cassette);
        if (!existsSync(RECORDINGS_DIR)) mkdirSync(RECORDINGS_DIR, {recursive: true});
        writeFileSync(cassettePath(name), JSON.stringify(cassette, null, 2) + '\n');
      },
    };
  }

  const cassette = loadCassette(name);
  let cursor = 0;
  const replayFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({method, url, body: parseBody(init?.body ?? null)});

    const interaction = cassette.interactions[cursor++];
    if (!interaction) {
      throw new Error(`cassette "${name}" exhausted: no recorded interaction for request #${cursor} (${method} ${url})`);
    }
    if (interaction.request.method !== method || interaction.request.url !== url) {
      throw new Error(
        `cassette "${name}" mismatch at #${cursor}: expected ${interaction.request.method} ${interaction.request.url}, ` +
          `got ${method} ${url} (re-record after reordering requests)`,
      );
    }
    return syntheticResponse(interaction.response.status, interaction.response.body);
  }) as typeof fetch;

  return {fetch: replayFetch, sent, save() {}};
}
