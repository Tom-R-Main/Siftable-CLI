import {describe, expect, it, vi} from 'vitest';
import {preflightCodex} from './preflight.js';
import type {ProcessRunResult, ProcessRunner} from './runtime.js';

const HELP = '--json --strict-config --ephemeral --skip-git-repo-check --sandbox --cd';
const ok = (stdout: string): ProcessRunResult => ({stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: 0, signal: null, stopped: null});

describe('Codex local compatibility preflight', () => {
  it('records the selected executable and version using bounded local probes only', async () => {
    const run = vi.fn<ProcessRunner>().mockImplementation(async request => ok(request.args[0] === '--version' ? 'codex-cli 0.159.0\n' : HELP));
    const result = await preflightCodex({codexBin: process.execPath, path: '/usr/bin:/bin', run});
    expect(result).toMatchObject({codexVersion: '0.159.0'});
    expect(run.mock.calls.map(([request]) => request.args)).toEqual([['--version'], ['exec', '--help']]);
    for (const [request] of run.mock.calls) {
      expect(request.timeoutMs).toBe(5000);
      expect(request.env.CODEX_HOME).toBe(request.env.HOME);
      expect(Object.keys(request.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH']);
    }
  });

  it('accepts another version when the required capabilities are present', async () => {
    const run: ProcessRunner = async request => ok(request.args[0] === '--version' ? 'codex-cli 1.2.3' : HELP);
    expect((await preflightCodex({codexBin: process.execPath, path: '/usr/bin', run})).codexVersion).toBe('1.2.3');
  });

  it.each(['not codex', 'codex-cli 0.000.0'])('rejects an unsupported binary version: %s', async version => {
    const run = vi.fn<ProcessRunner>().mockResolvedValue(ok(version));
    await expect(preflightCodex({codexBin: process.execPath, path: '/usr/bin', run})).rejects.toThrow(/supported CLI version/u);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects missing required capabilities before a model session', async () => {
    const run: ProcessRunner = async request => ok(request.args[0] === '--version' ? 'codex-cli 0.159.0' : '--json --sandbox --cd');
    await expect(preflightCodex({codexBin: process.execPath, path: '/usr/bin', run})).rejects.toThrow(/--strict-config/u);
  });

  it.each(['timeout', 'aborted'] as const)('rejects a %s local probe', async stopped => {
    const run: ProcessRunner = async () => ({...ok(''), stopped, exitCode: null});
    await expect(preflightCodex({codexBin: process.execPath, path: '/usr/bin', run})).rejects.toThrow(/preflight failed/u);
  });
});
