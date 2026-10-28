import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processRunner} from './ports.js';
import {trackReviewDirectory, untrackReviewDirectory, type RuntimeIdentity} from './lifecycle.js';
import type {ProcessRunner} from './runtime.js';

// These are the actual flags required by buildCodexExecArgs, rather than a guessed version floor.
const REQUIRED_EXEC_FLAGS = ['--json', '--strict-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', '--cd'];

/** Local capability check only: does not authenticate, call a provider, or assert model availability. */
export async function preflightCodex(options: {
  codexBin: string;
  path: string;
  signal?: AbortSignal;
  run?: ProcessRunner;
}): Promise<RuntimeIdentity> {
  const run = options.run ?? processRunner;
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const home = await mkdtemp(join(tmpdir(), 'sift-review-preflight-'));
  trackReviewDirectory(home);
  try {
    const codexBin = await realpath(options.codexBin);
    const probe = async (args: string[], maxStdoutBytes: number): Promise<string> => {
      const result = await run({
        command: codexBin, args, cwd: home,
        env: {PATH: options.path, HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8'},
        signal, timeoutMs: 5000, maxStdoutBytes, maxStderrBytes: 4096,
      });
      if (result.exitCode !== 0 || result.stopped || result.stdoutTruncated) {
        throw new Error('Codex compatibility preflight failed; select a supported executable with --codex-bin.');
      }
      return result.stdout;
    };
    const versionText = await probe(['--version'], 4096);
    const version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(versionText.trim())?.[1];
    if (!version || /^0\.0+\.0+(?:[-+]|$)/u.test(version)) {
      throw new Error('Codex did not report a supported CLI version; select the Codex CLI with --codex-bin.');
    }
    const help = await probe(['exec', '--help'], 128 * 1024);
    const missing = REQUIRED_EXEC_FLAGS.filter(flag => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s=<]|$)`, 'u').test(help));
    if (missing.length) throw new Error(`Codex ${version} lacks required review capabilities: ${missing.join(', ')}. Select another --codex-bin.`);
    return {codexBin, codexVersion: version};
  } finally {
    await rm(home, {recursive: true, force: true});
    untrackReviewDirectory(home);
  }
}
