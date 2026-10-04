// The real model session for `sift review`: codexClient (T2) in native
// provider mode. Each model call runs `codex exec` with a fresh private
// CODEX_HOME holding the generated config.toml and a link to the user's own
// Codex login file, which codex reads itself; this CLI never opens it. codex's
// shell and exec tools are disabled and the checkout is marked untrusted
// (packages/taster/src/models/codexConfig.ts).

import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import type {ModelClient, ModelRequest, ModelResponse} from '@siftable/taster';
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
  /** Path of the user's Codex login file; default $CODEX_HOME/auth.json. Only the path is used. */
  authFile?: string;
}

/** Where codex keeps the user's login. Computes a path; never touches the file. */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(home, 'auth.json');
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
    const failures = new Map<string, number>();
    const client = options.runtime.createCodexClient({
      codexBin: options.codexBin,
      exec: processRunner,
      toolHostEndpoint: loopbackMcpEndpoint,
      model: options.model,
      provider: 'native',
      nativeAuthFile: options.authFile ?? codexAuthPath(),
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
      close: async () => undefined,
      problems: () => {
        const out = [...failures.entries()].map(([key, count]) => `model call failed (${key}) x${count}`);
        if ([...failures.keys()].some(key => key.endsWith('turn_failed') || key.endsWith('process_failed'))) {
          out.push('if codex is not signed in, run `codex login` (file-based credential storage) and retry');
        }
        return out;
      },
    };
  };
}
