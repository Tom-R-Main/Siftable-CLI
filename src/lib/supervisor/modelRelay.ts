import {randomBytes, randomUUID} from 'node:crypto'
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'

/**
 * The supervisor's loopback model relay (first-run U2). Each agent container
 * gets one. The agent's SDK points ANTHROPIC_BASE_URL or OPENAI_BASE_URL at
 * it; the relay forwards each request to the run's attempt route on the API
 * (U4) with the supervisor's own credential and the attempt's claim, and
 * streams the provider's response back unchanged.
 *
 * Request identity (room 16880/16881):
 * - One agent request is one call: the relay mints a fresh Idempotency-Key
 *   for each and never retries. An SDK retry arrives as a new request and is a
 *   new call with its own budget hold.
 * - The agent's own credentials and Siftable headers are dropped; only the
 *   body and, for Messages, anthropic-beta are forwarded.
 * - Upstream statuses pass through unchanged, so a refusal (auth, admission,
 *   budget) never looks like transient provider capacity. Only a connection
 *   lost before a response becomes a protocol-shaped 502.
 * - Nothing about the request, the credential or the claim is logged.
 */
export type ModelRelayProtocol = 'anthropic' | 'openai-responses'
export type ModelRelayRole = 'reviewer' | 'writer'

export interface ModelRelayTarget {
  apiUrl: string
  attemptId: string
  /** The attempt's current claim token; read on every request, so a renewed claim is used at once. */
  claimToken: () => string
  protocol: ModelRelayProtocol
  role: ModelRelayRole
  /** The supervisor's own API credential, never the user's or the agent's. */
  supervisorToken: string
  workItemId: string
  workspaceId: null | string
}

export interface ModelRelayOptions {
  /** Address the agent container reaches the relay on. Defaults to loopback. */
  host?: string
  /** Largest request the relay accepts; the API takes 16 MB. */
  maxRequestBytes?: number
  /** Injected for tests. */
  fetch?: typeof fetch
  /**
   * The longest one request may take, forwarding included. Past it the relay
   * aborts the API call and ends the response, even for an agent that stopped
   * reading. A little over the API's own limit (7 minutes plus 15 s).
   */
  requestDeadlineMs?: number
}

export interface ModelRelay {
  /** Calls in flight; the supervisor reports it, and it falls to zero as each request ends. */
  activeCalls(): number
  /** The base URL to give the agent: ANTHROPIC_BASE_URL, or OPENAI_BASE_URL (which ends in /v1). */
  baseUrl: string
  stop(): Promise<void>
}

const AGENT_PATH: Readonly<Record<ModelRelayProtocol, string>> = {
  anthropic: '/v1/messages',
  'openai-responses': '/v1/responses',
}

const API_PATH: Readonly<Record<ModelRelayProtocol, string>> = {
  anthropic: 'anthropic/v1/messages',
  'openai-responses': 'openai/v1/responses',
}

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_DEADLINE_MS = 450_000

/** An error in the agent's own protocol, for failures the relay itself reports. */
function protocolError(protocol: ModelRelayProtocol, status: number, message: string): string {
  if (protocol === 'anthropic') {
    return JSON.stringify({type: 'error', error: {type: status === 413 ? 'request_too_large' : 'api_error', message}})
  }

  return JSON.stringify({error: {type: 'server_error', code: null, message, param: null}})
}

function send(res: ServerResponse, protocol: ModelRelayProtocol, status: number, message: string): void {
  if (res.headersSent) {
    res.end()
    return
  }

  res.writeHead(status, {'cache-control': 'no-store', 'content-type': 'application/json'})
  res.end(protocolError(protocol, status, message))
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) {
        // Answer now and drop the rest, so the agent gets a 413 rather than a reset it might retry.
        chunks.length = 0
        resolve(null)
        return
      }

      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Resolves when the response can take more data, the agent goes away, or the call is aborted. */
function writable(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }

    if (signal.aborted) {
      resolve()
      return
    }

    res.once('drain', done)
    res.once('close', done)
    signal.addEventListener('abort', done, {once: true})
  })
}

export async function startModelRelay(target: ModelRelayTarget, options: ModelRelayOptions = {}): Promise<ModelRelay> {
  const doFetch = options.fetch ?? fetch
  const limit = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  // The path carries a secret, so another process on the host that finds the port still cannot use the relay.
  const prefix = `/relay/${randomBytes(24).toString('base64url')}`
  const route = prefix + AGENT_PATH[target.protocol]
  const upstreamUrl = `${target.apiUrl.replace(/\/$/, '')}/api/v1/work-items/${encodeURIComponent(target.workItemId)}`
    + `/execution-attempts/${encodeURIComponent(target.attemptId)}/model/${API_PATH[target.protocol]}`
  const active = new Set<AbortController>()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || req.url !== route) {
      res.writeHead(404).end()
      return
    }

    const body = await readBody(req, limit)
    if (!body) {
      res.setHeader('connection', 'close')
      send(res, target.protocol, 413, 'The request is larger than the relay accepts')
      return
    }

    const abort = new AbortController()
    active.add(abort)
    const onClose = () => {
      if (!res.writableEnded) abort.abort()
    }

    res.once('close', onClose)
    // One deadline for the whole request, so a stalled agent cannot hold it open.
    const deadline = setTimeout(() => abort.abort(), options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS)
    deadline.unref()
    try {
      const headers: Record<string, string> = {
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${target.supervisorToken}`,
        'content-type': 'application/json',
        // One agent request is one call; the relay never reuses a key.
        'idempotency-key': `relay-${randomUUID()}`,
        'x-sift-claim-token': target.claimToken(),
        'x-sift-model-role': target.role,
      }
      if (target.workspaceId) headers['x-workspace-id'] = target.workspaceId
      const beta = req.headers['anthropic-beta']
      if (target.protocol === 'anthropic' && typeof beta === 'string') headers['anthropic-beta'] = beta

      let upstream: Response
      try {
        upstream = await doFetch(upstreamUrl, {body, headers, method: 'POST', redirect: 'error', signal: abort.signal})
      } catch {
        // The API may have received the call; its outcome stays unknown and held there.
        send(res, target.protocol, 502, 'The model relay lost its connection to Siftable')
        return
      }

      const responseHeaders: Record<string, string> = {
        'cache-control': 'no-store',
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      }
      const retryAfter = upstream.headers.get('retry-after')
      if (retryAfter) responseHeaders['retry-after'] = retryAfter
      res.writeHead(upstream.status, responseHeaders)
      if (!upstream.body) {
        res.end()
        return
      }

      const reader = upstream.body.getReader()
      let broken = false
      try {
        for (;;) {
          const {done, value} = await reader.read()
          if (done) break
          if (!res.write(value)) await writable(res, abort.signal)
          if (abort.signal.aborted) break
        }
      } catch {
        // The API connection broke mid-stream; the API keeps the call's outcome unknown.
        broken = true
      } finally {
        if (abort.signal.aborted || broken) {
          // A broken stream must not end like a complete one, and an agent that stopped reading would
          // never take the rest: close the connection rather than end the response.
          res.destroy()
          // The fetch is already aborted; releasing the reader must not hold this handler.
          reader.cancel().catch(() => undefined)
        } else {
          res.end()
        }
      }
    } finally {
      clearTimeout(deadline)
      res.off('close', onClose)
      active.delete(abort)
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, target.protocol, 502, 'The model relay failed'))
  })
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, options.host ?? '127.0.0.1', () => resolve())
  })
  const {address, port} = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  const base = `http://${host}:${port}${prefix}`
  return {
    activeCalls: () => active.size,
    // Anthropic's SDK appends /v1/messages; OpenAI's appends /responses to a base ending in /v1.
    baseUrl: target.protocol === 'anthropic' ? base : `${base}/v1`,
    async stop() {
      for (const call of active) call.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => {
        server.close(() => resolve())
      })
    },
  }
}
