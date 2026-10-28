import {createServer, request as httpRequest, type IncomingMessage, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'

import {type ModelRelay, startModelRelay, type ModelRelayTarget} from './modelRelay.js'

interface Received {
  body: string
  headers: IncomingMessage['headers']
  url: string
}

let upstream: Server | undefined
let relay: ModelRelay | undefined

afterEach(async () => {
  await relay?.stop()
  relay = undefined
  await new Promise<void>(resolve => {
    if (!upstream) return resolve()
    upstream.closeAllConnections()
    upstream.close(() => resolve())
  })
  upstream = undefined
})

/** A stand-in for the API's attempt route that records what it received. */
async function api(respond: (req: IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const received: Received[] = []
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({body: Buffer.concat(chunks).toString(), headers: req.headers, url: req.url ?? ''})
      respond(req, res)
    })
  })
  await new Promise<void>(resolve => {
    upstream!.listen(0, '127.0.0.1', () => resolve())
  })
  const {port} = upstream.address() as AddressInfo
  return {received, url: `http://127.0.0.1:${port}`}
}

function target(apiUrl: string, overrides: Partial<ModelRelayTarget> = {}): ModelRelayTarget {
  return {
    apiUrl,
    attemptId: '22222222-2222-4222-8222-222222222222',
    claimToken: () => 'claim-1',
    protocol: 'anthropic',
    role: 'writer',
    supervisorToken: 'supervisor-token',
    workItemId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'org-1',
    ...overrides,
  }
}

const SSE = 'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n'

describe('supervisor model relay', () => {
  it('forwards an agent request to the attempt route with the supervisor identity and streams the reply back', async () => {
    const {received, url} = await api((_req, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream', 'x-sift-call-id': 'call-1'})
      res.write(SSE.slice(0, 20))
      res.end(SSE.slice(20))
    })
    relay = await startModelRelay(target(url))
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {
      body: JSON.stringify({max_tokens: 10, messages: []}),
      headers: {
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        authorization: 'Bearer agent-key', cookie: 'session=agent', 'idempotency-key': 'agent-key-1',
        'x-api-key': 'sk-agent', 'x-sift-claim-token': 'forged', 'x-sift-model-role': 'reviewer', 'x-workspace-id': 'other',
      },
      method: 'POST',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-sift-call-id')).toBeNull()
    expect(await response.text()).toBe(SSE)
    const [call] = received
    expect(call.url).toBe('/api/v1/work-items/11111111-1111-4111-8111-111111111111/execution-attempts/22222222-2222-4222-8222-222222222222/model/anthropic/v1/messages')
    expect(call.body).toBe(JSON.stringify({max_tokens: 10, messages: []}))
    expect(call.headers).toMatchObject({
      'anthropic-beta': 'interleaved-thinking-2025-05-14', authorization: 'Bearer supervisor-token',
      'x-sift-claim-token': 'claim-1', 'x-sift-model-role': 'writer', 'x-workspace-id': 'org-1',
    })
    expect(call.headers['x-api-key']).toBeUndefined()
    expect(call.headers.cookie).toBeUndefined()
    expect(call.headers['idempotency-key']).toMatch(/^relay-[0-9a-f-]{36}$/)
  })

  it('gives every request a fresh key, so an SDK retry is a new call, and reads the current claim each time', async () => {
    const {received, url} = await api((_req, res) => res.writeHead(200, {'content-type': 'text/event-stream'}).end(SSE))
    let claim = 'claim-1'
    relay = await startModelRelay(target(url, {claimToken: () => claim}))
    for (let i = 0; i < 2; i++) {
      await (await fetch(`${relay.baseUrl}/v1/messages`, {body: '{}', method: 'POST'})).text()
      claim = 'claim-2'
    }

    expect(received[0].headers['idempotency-key']).not.toBe(received[1].headers['idempotency-key'])
    expect(received.map(call => call.headers['x-sift-claim-token'])).toEqual(['claim-1', 'claim-2'])
  })

  it('passes a refusal through unchanged rather than as transient capacity', async () => {
    const refusal = JSON.stringify({error: 'The call\'s worst case exceeds what is left of the budget'})
    const {url} = await api((_req, res) => res.writeHead(409, {'content-type': 'application/json'}).end(refusal))
    relay = await startModelRelay(target(url))
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {body: '{}', method: 'POST'})
    expect(response.status).toBe(409)
    expect(await response.text()).toBe(refusal)
  })

  it('passes a provider overload and its retry hint through', async () => {
    const {url} = await api((_req, res) => res.writeHead(529, {'content-type': 'application/json', 'retry-after': '7'}).end('{"type":"error"}'))
    relay = await startModelRelay(target(url))
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {body: '{}', method: 'POST'})
    expect(response.status).toBe(529)
    expect(response.headers.get('retry-after')).toBe('7')
  })

  it('answers a lost connection with a 502 in the agent\'s protocol', async () => {
    relay = await startModelRelay(target('http://127.0.0.1:1'), {fetch: async () => {
      throw new TypeError('fetch failed')
    }})
    const anthropic = await fetch(`${relay.baseUrl}/v1/messages`, {body: '{}', method: 'POST'})
    expect(anthropic.status).toBe(502)
    expect(await anthropic.json()).toMatchObject({error: {type: 'api_error'}, type: 'error'})
    await relay.stop()
    relay = await startModelRelay(target('http://127.0.0.1:1', {protocol: 'openai-responses', role: 'reviewer'}), {fetch: async () => {
      throw new TypeError('fetch failed')
    }})
    const responses = await fetch(`${relay.baseUrl}/responses`, {body: '{}', method: 'POST'})
    expect(responses.status).toBe(502)
    expect(await responses.json()).toMatchObject({error: {type: 'server_error'}})
  })

  it('serves only its own protocol path under its secret prefix', async () => {
    const {received, url} = await api((_req, res) => res.writeHead(200).end())
    relay = await startModelRelay(target(url, {protocol: 'openai-responses', role: 'reviewer'}))
    expect(relay.baseUrl).toMatch(/\/v1$/)
    const origin = new URL(relay.baseUrl).origin
    expect((await fetch(`${origin}/v1/responses`, {body: '{}', method: 'POST'})).status).toBe(404)
    expect((await fetch(`${relay.baseUrl.replace(/\/v1$/, '')}/v1/messages`, {body: '{}', method: 'POST'})).status).toBe(404)
    expect((await fetch(`${relay.baseUrl}/responses`, {method: 'GET'})).status).toBe(404)
    expect((await fetch(`${relay.baseUrl}/responses`, {body: '{}', method: 'POST'})).status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].url).toMatch(/\/model\/openai\/v1\/responses$/)
  })

  it('refuses a request over its size limit without calling the API', async () => {
    const {received, url} = await api((_req, res) => res.writeHead(200).end())
    relay = await startModelRelay(target(url), {maxRequestBytes: 16})
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {body: 'x'.repeat(64), method: 'POST'}).catch(() => null)
    if (response) expect(response.status).toBe(413)
    expect(received).toHaveLength(0)
  })

  it('cancels the API call when the agent goes away mid-stream', async () => {
    let upstreamClosed = false
    const {url} = await api((req, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      res.write('event: message_start\ndata: {}\n\n')
      req.socket.on('close', () => {
        upstreamClosed = true
      })
    })
    relay = await startModelRelay(target(url))
    const agent = new AbortController()
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {body: '{}', method: 'POST', signal: agent.signal})
    const reader = response.body!.getReader()
    await reader.read()
    agent.abort()
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    expect(upstreamClosed).toBe(true)
  })

  it('ends a request at its deadline when the agent stops reading but stays connected', async () => {
    let upstreamClosed = false
    const {url} = await api((req, res) => {
      res.writeHead(200, {'content-type': 'text/event-stream'})
      // Far more than the socket buffers hold, so the relay's writes report backpressure.
      const frame = `event: content_block_delta\ndata: ${'x'.repeat(64 * 1024)}\n\n`
      const pump = () => {
        while (res.write(frame)) { /* fill */ }
        res.once('drain', pump)
      }

      pump()
      req.socket.on('close', () => {
        upstreamClosed = true
      })
    })
    relay = await startModelRelay(target(url), {requestDeadlineMs: 200})
    const {hostname, pathname, port} = new URL(`${relay.baseUrl}/v1/messages`)
    let started = false
    const req = httpRequest({hostname, method: 'POST', path: pathname, port}, res => {
      started = true
      // The agent never reads, but keeps the connection open.
      res.pause()
    })
    req.on('error', () => undefined)
    req.end('{}')
    await new Promise(resolve => {
      setTimeout(resolve, 100)
    })
    expect(started).toBe(true)
    expect(relay.activeCalls()).toBe(1)
    await new Promise(resolve => {
      setTimeout(resolve, 400)
    })
    // Past the deadline the relay has let go on its own: the API call is cancelled and nothing is in flight.
    expect(upstreamClosed).toBe(true)
    expect(relay.activeCalls()).toBe(0)
    req.destroy()
  })
})
