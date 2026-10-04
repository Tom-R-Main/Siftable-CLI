// The real model session for `sift review`: codexClient (T2) pointed at the
// loopback Codex-login relay. Each model call runs `codex exec` with a fresh
// private CODEX_HOME, codex's shell and exec tools disabled, and the
// checkout marked untrusted (packages/taster/src/models/codexConfig.ts).

import type {ModelClient, ModelRequest, ModelResponse} from '@siftable/taster';
import {readCodexLogin, startCodexLoginRelay, type CodexLogin} from './codexLoginRelay.js';
import type {ModelSessionFactory} from './localReview.js';
import {loopbackMcpEndpoint, processRunner} from './ports.js';
import type {TasterRuntime} from './runtime.js';

export interface CodexSessionOptions {
  runtime: TasterRuntime;
  codexBin: string;
  model: string;
  path: string;
  concurrency: number;
  callTimeoutMs: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Defaults to the user's own Codex login file. */
  login?: CodexLogin;
}

/** Records how model calls failed, by error code, without any model output. */
function recordingClient(inner: ModelClient, failures: Map<string, number>): ModelClient {
  return {
    async run(request: ModelRequest): Promise<ModelResponse> {
      try {
        return await inner.run(request);
      } catch (error) {
        const code = (error as {code?: unknown}).code;
        const key = `${request.role} ${typeof code === 'string' ? code : 'error'}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
        throw error;
      }
    },
  };
}

export function codexSessionFactory(options: CodexSessionOptions): ModelSessionFactory {
  return async ({checkoutRoot, workDir}) => {
    const login = options.login ?? readCodexLogin();
    const relay = await startCodexLoginRelay({login, model: options.model});
    const failures = new Map<string, number>();
    try {
      const client = options.runtime.createCodexClient({
        codexBin: options.codexBin,
        exec: processRunner,
        toolHostEndpoint: loopbackMcpEndpoint,
        model: options.model,
        proxyBaseUrl: relay.baseUrl,
        // codex's own sandbox works on a developer machine (Seatbelt on macOS,
        // Landlock or bubblewrap on Linux); with the shell disabled it is defence in depth.
        sandbox: 'read-only',
        checkoutRoot,
        workDir,
        maxConcurrent: options.concurrency,
        timeoutMs: options.callTimeoutMs,
        path: options.path,
        ...(options.reasoningEffort ? {reasoningEffort: options.reasoningEffort} : {}),
      });
      return {
        models: recordingClient(client, failures),
        close: () => relay.close(),
        problems: () => {
          const out = [...failures.entries()].map(([key, count]) => `model call failed (${key}) x${count}`);
          const rejected = Object.entries(relay.stats.upstreamStatuses).filter(([status]) => status !== '200');
          if (rejected.length > 0) out.push(`model upstream answered ${rejected.map(([status, count]) => `${status} x${count}`).join(', ')}`);
          if (relay.stats.upstreamStatuses['401'] || relay.stats.upstreamStatuses['403']) {
            out.push('the Codex login was rejected; run `codex login` and retry');
          }
          if (relay.stats.refused > 0) out.push(`relay refused ${relay.stats.refused} request(s)`);
          return out;
        },
      };
    } catch (error) {
      await relay.close();
      throw error;
    }
  };
}
