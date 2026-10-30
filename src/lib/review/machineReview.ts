/**
 * The reviewer container's program (first-run U3-2 contract rev 2): a Taster
 * review of the verified result, run by the supervisor in its review phase.
 *
 * The verified tree is mounted read-only at /verify/src with its own git
 * directory at /verify/g, whose file-based alternates name the base objects
 * at /workspace/.git/objects (also mounted read-only). Every git call carries
 * those two paths explicitly, whatever the engine passes.
 *
 * Model calls go through codexClient in proxy mode to a loopback forwarder,
 * which carries only `POST /v1/responses` to the attempt's reviewer relay
 * (the sidecar), which the supervisor bills to the reviewer budget. The
 * container has no other route out.
 *
 * Output is one JSON line on stdout (`sift.review-result/v1`).
 */
import {createServer, type IncomingMessage, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {codexSessionFactory} from './codexSession.js';
import {DEFAULT_BUDGET, type LocalReviewDeps, type LocalReviewOutcome, type LocalReviewOptions, runLocalReview} from './localReview.js';
import type {GitExec, TasterRuntime} from './runtime.js';

export const REVIEW_RESULT_VERSION = 'sift.review-result/v1';
export const VERIFY_TREE = '/verify/src';
export const VERIFY_GIT_DIR = '/verify/g';
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export interface MachineReviewRequest {
  baseSha: string;
  /** The result head the supervisor committed; the review must be of exactly this commit. */
  head: string;
  model: string;
}

/** Every git call sees the verified tree and its own git directory, and takes no optional locks on the read-only mounts. */
export function verifiedTreeGit(git: GitExec, tree = VERIFY_TREE, gitDir = VERIFY_GIT_DIR): GitExec {
  return (args, options) => git(args, {...options, env: {...options.env, GIT_DIR: gitDir, GIT_WORK_TREE: tree, GIT_OPTIONAL_LOCKS: '0'}});
}

function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { request.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(null));
  });
}

/**
 * A loopback HTTP server whose only route, `POST /v1/responses`, is forwarded to `responsesUrl` (the sidecar's
 * reviewer route) with the request's body and content type, the reply streamed back as it arrives. codexClient
 * accepts only a loopback proxy base; this is that base.
 */
export async function startForwarder(responsesUrl: string, fetchImpl: typeof fetch = fetch): Promise<{baseUrl: string; server: Server}> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      const body = await readBody(request);
      if (!body) { response.writeHead(413).end(); return; }
      // codex going away (exit, cancel) ends the relay call too, so it stops consuming the reviewer budget.
      const upstreamLife = new AbortController();
      response.on('close', () => { if (!response.writableFinished) upstreamLife.abort(); });
      let upstream: Response;
      try {
        upstream = await fetchImpl(responsesUrl, {method: 'POST', redirect: 'error', body, signal: upstreamLife.signal,
          headers: {'Content-Type': request.headers['content-type'] ?? 'application/json',
            ...(request.headers.accept ? {Accept: request.headers.accept} : {})}});
      } catch {
        response.writeHead(502, {'Content-Type': 'application/json'}).end('{"error":{"type":"sift_forwarder","message":"relay unreachable"}}');
        return;
      }
      response.writeHead(upstream.status, {'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream'});
      if (!upstream.body) { response.end(); return; }
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk);
        response.end();
      } catch {
        // The relay dropped mid-stream (Release R12): codex sees a broken stream, never a silently complete one.
        await upstream.body.cancel().catch(() => undefined);
        response.destroy();
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server};
}

export interface MachineReviewDeps {
  runtime: TasterRuntime;
  git: GitExec;
  gitBin: string;
  codexBin: string;
  path: string;
  /** The sidecar's reviewer Responses route. */
  relayResponsesUrl: string;
  fetch?: typeof fetch;
  review?: (options: LocalReviewOptions, deps: LocalReviewDeps) => Promise<LocalReviewOutcome>;
  signal?: AbortSignal;
}

/** Reviews the verified result and returns the result line's object. Never throws for a review that ran. */
export async function runMachineReview(request: MachineReviewRequest, deps: MachineReviewDeps): Promise<Record<string, unknown>> {
  const forwarder = await startForwarder(deps.relayResponsesUrl, deps.fetch);
  try {
    const git = verifiedTreeGit(deps.git);
    const outcome = await (deps.review ?? runLocalReview)({
      cwd: VERIFY_TREE, baseRef: request.baseSha, expectedHead: request.head, model: request.model, provider: 'codex-proxy', finderPasses: 2,
      budget: DEFAULT_BUDGET, ...(deps.signal ? {signal: deps.signal} : {}),
    }, {
      runtime: deps.runtime, gitBin: deps.gitBin, path: deps.path, git,
      modelSession: (context) => codexSessionFactory({runtime: deps.runtime, codexBin: deps.codexBin, model: request.model, path: deps.path,
        concurrency: DEFAULT_BUDGET.concurrency, callTimeoutMs: DEFAULT_BUDGET.callTimeoutMs, proxyBaseUrl: forwarder.baseUrl})(context),
    });
    return {version: REVIEW_RESULT_VERSION, ok: true, receipt: outcome.receipt};
  } catch (error) {
    return {version: REVIEW_RESULT_VERSION, ok: false, code: 'review_failed', detail: String((error as Error).message).slice(0, 500)};
  } finally {
    await new Promise((resolve) => forwarder.server.close(() => resolve(undefined)));
  }
}
