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
  /**
   * Proxy mode (first-run U3-2): codex talks only to this loopback Responses base, which forwards to the attempt's
   * reviewer relay; no login file is linked. The container is the sandbox, so codex's own is off.
   */
  proxyBaseUrl?: string;
}

/** Where codex keeps the user's login. Computes a path; never touches the file. */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(homedir(), '.codex');
  return join(home, 'auth.json');
}

export type ModelFailureClass =
  | 'usage_limit'
  | 'rate_limit'
  | 'auth'
  | 'context_length'
  | 'model_unavailable'
  | 'server_error'
  | 'network'
  | 'other';

// Checked in order: a usage-limit message can also carry a 429 status.
const FAILURE_PATTERNS: ReadonlyArray<readonly [ModelFailureClass, RegExp]> = [
  ['usage_limit', /usage limit|quota|insufficient[_ ]credits?|billing|plan limit/iu],
  ['rate_limit', /\b429\b|rate[ _-]?limit|too many requests/iu],
  ['auth', /\b40[13]\b|unauthori[sz]ed|forbidden|not (?:signed|logged) in|authenticat|invalid api key|(?:token|session) (?:has )?expired|refresh token/iu],
  ['context_length', /context (?:window|length)|maximum context|too many tokens|token limit/iu],
  // Within one sentence (a dot followed by a non-space, as in `gpt-6.1-sol`, does not end it).
  // Not codex's "Model metadata for `x` not found" notice: 0.159 emits it on calls that succeed.
  ['model_unavailable', /\b404\b|model(?! metadata)(?:[^.]|\.(?=\S))*?(?:not found|does not exist|not supported|unavailable)|unsupported model/iu],
  ['server_error', /\b50[0-4]\b|overloaded|internal server error|service unavailable|bad gateway|server error/iu],
  ['network', /stream disconnected|connection (?:reset|refused|closed)|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|network|dns/iu],
];

/**
 * Maps codex's failure message to a fixed class. Only the class is ever
 * reported: the message is codex's own text and may name accounts or URLs.
 */
export function classifyModelFailure(message: string | undefined): ModelFailureClass | undefined {
  if (message === undefined || message.trim() === '') return undefined;
  for (const [failureClass, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(message)) return failureClass;
  }
  return 'other';
}

function failureMessage(error: unknown, code: unknown): string | undefined {
  const telemetry = (error as {telemetry?: {failure?: unknown; warnings?: unknown}}).telemetry;
  if (typeof telemetry?.failure === 'string') return telemetry.failure;
  // Only a process that ended without a terminal turn event falls back to its last
  // warning, which is then usually a stream error. Warnings also carry informational
  // notices, so a completed turn whose output failed validation gets no class.
  if (code !== 'process_failed') return undefined;
  const warnings = Array.isArray(telemetry?.warnings) ? telemetry.warnings.filter(w => typeof w === 'string') : [];
  return warnings.at(-1);
}

/** Records how model calls failed, by error code and failure class, without any model output or message text. */
function recordingClient(inner: ModelClient, failures: Map<string, number>): ModelClient {
  return {
    async run(request: ModelRequest): Promise<ModelResponse> {
      try {
        return await inner.run(request);
      } catch (error) {
        const code = (error as {code?: unknown}).code;
        const failureClass = classifyModelFailure(failureMessage(error, code));
        const key = `${request.role} ${typeof code === 'string' ? code : 'error'}${failureClass ? `:${failureClass}` : ''}`;
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
      ...(options.proxyBaseUrl
        ? {provider: 'proxy' as const, proxyBaseUrl: options.proxyBaseUrl, sandbox: 'danger-full-access' as const}
        // codex's own sandbox works on a developer machine (Seatbelt on macOS,
        // Landlock or bubblewrap on Linux); with the shell disabled it is defence in depth.
        : {provider: 'native' as const, nativeAuthFile: options.authFile ?? codexAuthPath(), sandbox: 'read-only' as const}),
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
        if ([...failures.keys()].some(key => key.endsWith(':auth'))) {
          out.push('codex reported an authentication failure: run `codex login` (file-based credential storage) and retry');
        }
        return out;
      },
    };
  };
}
