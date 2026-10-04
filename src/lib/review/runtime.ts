// The Taster runtime that `sift review` drives (docs/architecture/taster-review.md
// sections 5 and 9). @siftable/taster is a private workspace package, so the
// CLI build compiles the engine, model clients, trusted policy bundle loader,
// the runner's trusted pre-pass and its prompt budget into
// dist/lib/vendor/taster (see tsconfig.vendor.json), and copies the default
// policy bundle and T3's ratchet growth detector next to them. Engine and
// contract types come from the package's declarations; the model client and
// pre-pass ports are declared here because the package does not export them.

import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type {GitExec, ModelClient, PolicyBundle, ReviewInput, ReviewResult} from '@siftable/taster';

/** Process port of the model client (packages/taster/src/models/types.ts ProcessRunner). */
export interface ProcessRunRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  stopped: 'aborted' | 'timeout' | null;
}

export type ProcessRunner = (request: ProcessRunRequest) => Promise<ProcessRunResult>;

/** Loopback MCP endpoint port (packages/taster/src/toolhost/mcpToolHost.ts). */
export type McpMessageHandler = (message: unknown) => Promise<unknown>;
export interface McpEndpoint {
  url: string;
  close(): Promise<void>;
}
export type McpEndpointFactory = (handle: McpMessageHandler) => Promise<McpEndpoint>;

/** The subset of createCodexClient's options `sift review` sets. */
export interface CodexClientOptions {
  codexBin: string;
  exec: ProcessRunner;
  toolHostEndpoint: McpEndpointFactory;
  model: string;
  provider?: 'proxy' | 'native';
  proxyBaseUrl?: string;
  /** Native mode: path of the user's Codex login, linked into each call's CODEX_HOME; never opened by Taster. */
  nativeAuthFile?: string;
  sandbox: 'read-only' | 'danger-full-access';
  checkoutRoot: string;
  workDir: string;
  maxConcurrent?: number;
  timeoutMs?: number;
  path?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface PrepassInput {
  repo: string;
  baseSha: string;
  mergeBase: string;
  head: string;
  ratchetGrowth: string;
  envPath?: string;
}

export interface PrepassOutput {
  reports: unknown[];
  problems: string[];
}

export interface PromptParts {
  fileListBytes: number;
  checkpointListBytes: number;
  summaryBytes: number;
  prTextBytes: number;
  trustedBytes: number;
}

export interface TasterRuntime {
  review(input: ReviewInput): Promise<ReviewResult>;
  GIT_ENV: Readonly<Record<string, string>>;
  loadDefaultPolicyBundle(): PolicyBundle;
  createCodexClient(options: CodexClientOptions): ModelClient;
  runTrustedPrepass(input: PrepassInput): PrepassOutput;
  diffAllowance(parts: PromptParts): number;
  summaryBytes(reports: readonly unknown[]): number;
  /** Bytes of the engine's changed-file list from `git diff --name-status -z -M` output. */
  fileListBytes(nameStatusZ: string): number;
  /** Absolute path of T3's ratchet growth detector (trusted, shipped with the CLI). */
  ratchetGrowthScript: string;
}

export type {GitExec};

function required<T>(module: Record<string, unknown>, name: string, file: string): T {
  const value = module[name];
  if (value === undefined) throw new Error(`Packaged Taster runtime is invalid: ${file} does not export ${name}. Rebuild @siftable/cli.`);
  return value as T;
}

/** Root of the vendored runtime next to this module (dist/lib/review -> dist/lib/vendor/taster). */
export function vendoredRuntimeRoot(): string | undefined {
  return [
    resolve(__dirname, '..', 'vendor', 'taster'),
    resolve(__dirname, '..', '..', '..', 'dist', 'lib', 'vendor', 'taster'),
  ].find(candidate => existsSync(resolve(candidate, 'src', 'engine', 'index.js')));
}

/** Loads the vendored runtime; throws with a rebuild hint when it is missing. */
export function loadTasterRuntime(root = vendoredRuntimeRoot()): TasterRuntime {
  if (!root) throw new Error('The Taster review runtime is not packaged with this CLI build. Rebuild @siftable/cli.');
  const load = (relative: string): Record<string, unknown> => require(resolve(root, relative)) as Record<string, unknown>;
  const engine = load('src/engine/index.js');
  const models = load('src/models/index.js');
  const node = load('src/node.js');
  const prepass = load('runner/src/prepass/cli.js');
  const budget = load('runner/src/promptBudget.js');
  const ratchetGrowthScript = resolve(root, 'trusted', 'scripts', 'ci', 'ratchetGrowth.mjs');
  if (!existsSync(ratchetGrowthScript)) throw new Error('Packaged Taster runtime is missing the ratchet growth detector. Rebuild @siftable/cli.');
  return {
    review: required(engine, 'review', 'engine'),
    GIT_ENV: required(engine, 'GIT_ENV', 'engine'),
    loadDefaultPolicyBundle: required(node, 'loadDefaultPolicyBundle', 'node'),
    createCodexClient: required(models, 'createCodexClient', 'models'),
    runTrustedPrepass: required(prepass, 'runTrustedPrepass', 'prepass'),
    diffAllowance: required(budget, 'diffAllowance', 'promptBudget'),
    summaryBytes: required(budget, 'summaryBytes', 'promptBudget'),
    fileListBytes: required(budget, 'fileListBytes', 'promptBudget'),
    ratchetGrowthScript,
  };
}
