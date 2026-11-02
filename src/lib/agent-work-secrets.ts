import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

interface AgentWorkSecretsRuntime {
  findInlineAgentWorkSecret(value: unknown): {kind: 'key' | 'value'; path: string} | null;
}
let loadedRuntime: AgentWorkSecretsRuntime | undefined;

/** Load the canonical policy from the CLI's packaged shared runtime. */
export function hasInlineAgentWorkSecrets(value: unknown): boolean {
  if (!loadedRuntime) {
    const runtimePath = [
      resolve(__dirname, 'vendor', 'agentWorkSecrets.js'),
      resolve(__dirname, '..', '..', 'dist', 'lib', 'vendor', 'agentWorkSecrets.js'),
    ].find(candidate => existsSync(candidate));
    if (!runtimePath) throw new Error('Packaged work secret policy is unavailable. Rebuild @siftable/cli.');
    const runtime = require(runtimePath) as Partial<AgentWorkSecretsRuntime>;
    if (typeof runtime.findInlineAgentWorkSecret !== 'function') throw new Error('Packaged work secret policy is invalid.');
    loadedRuntime = runtime as AgentWorkSecretsRuntime;
  }
  return loadedRuntime.findInlineAgentWorkSecret(value) !== null;
}
