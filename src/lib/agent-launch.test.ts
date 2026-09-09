import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import AgentRun, {agentChildEnv, runHeadlessChild, validateAgentBaseUrl} from '../commands/agent/run.js';
import {findBun, resolveTuiRuntime} from '../commands/interactive.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
vi.mock('../commands/interactive.js', async importOriginal => ({
  ...await importOriginal<typeof import('../commands/interactive.js')>(),
  findBun: vi.fn(), resolveTuiRuntime: vi.fn(),
}));

let root: string;
let config: Config;
let child: EventEmitter & {pid?: number; exitCode: null; signalCode: null; kill: ReturnType<typeof vi.fn>};
let previousExitCode: typeof process.exitCode;
const argv = ['--prompt', 'Fixture task', '--provider', 'openrouter', '--model', 'fixture-model'];
beforeAll(async () => { config = await Config.load({root: resolve(__dirname, '../..')}); });
beforeEach(() => {
  previousExitCode = process.exitCode;
  root = mkdtempSync(join(tmpdir(), 'sift-agent-launch-'));
  mkdirSync(join(root, 'workspace'));
  writeFileSync(join(root, 'headless.ts'), '// launch fixture');
  writeFileSync(join(root, 'headless.js'), '// packaged launch fixture');
  vi.stubEnv('SIFT_INTERACTIVE_RUNTIME', 'source');
  vi.mocked(findBun).mockReturnValue(process.execPath);
  vi.mocked(resolveTuiRuntime).mockReturnValue({cwd: root, entry: join(root, 'index.tsx')});
  child = Object.assign(new EventEmitter(), {pid: 42, exitCode: null, signalCode: null, kill: vi.fn().mockReturnValue(true)});
  vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => child.emit('close', 0, null)); return child as never; });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks();
  process.exitCode = previousExitCode;
  rmSync(root, {recursive: true, force: true});
});

function run(extra: string[] = []) {
  return new AgentRun([...argv, ...(extra.includes('--cwd') ? [] : ['--cwd', join(root, 'workspace')]), ...extra], config).run();
}

describe('agent run launcher', () => {
  it('forwards the supervisor control pipe only for explicit JSONL handoff', async () => {
    await run(['--supervisor-handoff', '--handoff-timeout-ms', '1800000']);
    const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--supervisor-handoff', '--handoff-timeout-ms', '1800000']));
    expect(options?.stdio).toEqual(['inherit', 'inherit', 'inherit']);
  });
  it.each([['--supervisor-handoff', '--json'], ['--handoff-timeout-ms', '1000'], ['--supervisor-handoff', '--handoff-timeout-ms', '1800001']])('rejects invalid handoff flags %s', async (...extra) => {
    await expect(run(extra)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('runs noninteractively with a fresh session, bounded defaults and no PAT requirement', async () => {
    vi.stubEnv('SIFT_PAT', 'opaque-hosted-fixture');
    vi.stubEnv('OPENROUTER_API_KEY', 'opaque-provider-fixture');
    await run(['--no-input']);
    const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--approval', 'deny', '--max-rounds', '24', '--deadline-ms', '600000', '--format', 'jsonl']));
    expect(args?.[args.indexOf('--session') + 1]).toMatch(/^[a-f0-9-]{36}$/);
    expect(args?.join(' ')).not.toContain('opaque-');
    expect(options).toMatchObject({stdio: ['ignore', 'inherit', 'inherit'], env: {SIFT_LOCAL_ONLY: '1', OPENROUTER_API_KEY: 'opaque-provider-fixture'}});
    expect(options?.env).not.toHaveProperty('SIFT_PAT');
    expect(process.exitCode).toBe(0);
  });

  it('maps --json and preserves explicit execution settings', async () => {
    await run(['--json', '--session', 'resume-1', '--approval', 'allow', '--max-rounds', '8', '--deadline-ms', '5000', '--base-url', 'http://127.0.0.1:9191/v1', '--max-output-tokens', '1024', '--effort', 'medium']);
    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toEqual(expect.arrayContaining(['--format', 'json', '--session', 'resume-1', '--approval', 'allow', '--max-rounds', '8', '--deadline-ms', '5000', '--base-url', 'http://127.0.0.1:9191/v1', '--max-output-tokens', '1024', '--effort', 'medium']));
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('forwards effort %s', async effort => {
    await run(['--effort', effort]);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--effort', effort]));
  });

  it('selects only the requested runtime preference', async () => {
    vi.stubEnv('SIFT_INTERACTIVE_RUNTIME', 'packaged');
    await run();
    expect(resolveTuiRuntime).toHaveBeenCalledWith(expect.any(String), 'packaged');
    expect(vi.mocked(spawn).mock.calls[0]?.[1]?.[0]).toBe(join(root, 'headless.js'));
  });

  it('does not fall back to source when the packaged entry is absent', async () => {
    vi.stubEnv('SIFT_INTERACTIVE_RUNTIME', 'packaged');
    rmSync(join(root, 'headless.js'));
    await expect(run()).rejects.toThrow('packaged headless agent runtime');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves symlinked cwd to the real writable root', async () => {
    const alias = join(root, 'alias'); symlinkSync(join(root, 'workspace'), alias);
    await run(['--cwd', alias]);
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env?.SIFT_WORKSPACE_ROOT).toBe(options?.env?.SIFT_USER_CWD);
    expect(options?.env?.SIFT_WORKSPACE_ROOT).not.toBe(alias);
  });

  it.each([
    ['--cwd', '/definitely/not/an/existing/workspace'], ['--cwd', '.file'],
    ['--base-url', 'http://remote.example/v1'], ['--session', '../escape'], ['--deadline-ms', '0'], ['--max-rounds', '0'],
    ['--deadline-ms', '86400001'], ['--max-rounds', '257'], ['--max-output-tokens', '131073'], ['--max-output-tokens', '0'], ['--effort', 'unsupported'],
  ])('rejects invalid launch settings before dispatch: %s %s', async (flag, value) => {
    if (value === '.file') { value = join(root, 'file'); writeFileSync(value, 'fixture'); }
    await expect(run([flag, value])).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('headless child lifecycle', () => {
  function start(signals = new EventEmitter()) {
    vi.mocked(spawn).mockReturnValue(child as never);
    return {signals, result: runHeadlessChild({executable: 'fixture-runtime', args: [], cwd: root, env: {}, signals})};
  }

  it('forwards interruption, waits for close and cannot report success afterward', async () => {
    const {signals, result} = start();
    let settled = false; void result.then(() => { settled = true; });
    signals.emit('SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 0, null);
    expect(await result).toBe(130);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it.each([{code: 5, signal: null, expected: 5}, {code: null, signal: 'SIGTERM', expected: 143}, {code: null, signal: null, expected: 1}])('preserves terminal outcome $expected', async ({code, signal, expected}) => {
    const {result} = start(); child.emit('close', code, signal); expect(await result).toBe(expected);
  });

  it('cleans up signal listeners after spawn failure', async () => {
    child.pid = undefined;
    const {signals, result} = start(); child.emit('error', new Error('spawn failed'));
    await expect(result).rejects.toThrow('spawn failed');
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('waits for close after an error in an already spawned process', async () => {
    const {result} = start(); let settled = false; void result.then(() => { settled = true; });
    child.emit('error', new Error('kill failed')); await Promise.resolve(); expect(settled).toBe(false);
    child.emit('close', 0, null); expect(await result).toBe(1);
  });
});

describe('headless launch boundaries', () => {
  it.each(['https://provider.example/v1', 'http://localhost:3000/v1', 'http://127.2.0.1/v1', 'http://[::1]/v1'])('accepts supported endpoint %s', value => {
    expect(validateAgentBaseUrl(value)).toBe(value);
  });
  it.each(['https://key:secret@provider.example', 'https://provider.example?key=secret', 'https://provider.example#secret', 'http://provider.example', 'file:///tmp', 'not a URL'])('rejects unsupported endpoint without echoing it', value => {
    expect(() => validateAgentBaseUrl(value)).toThrow();
    try { validateAgentBaseUrl(value); } catch (error) { expect(String(error)).not.toContain('secret'); }
  });
  it('overrides local roots and scrubs hosted auth and ambient approval', () => {
    const env = agentChildEnv({cwd: '/work', runtimeDir: '/runtime', provider: 'meta', model: 'fixture', baseEnv: {META_API_KEY: 'opaque', SIFT_PAT: 'opaque', SIFT_TOKEN: 'opaque', EXF_TOKEN: 'opaque', SIFT_WORKSPACE_ID: 'wrong', EXECUTERM_AUTO_APPROVE: '1', EXECUTERM_OPENFUNCTION_PATH: '/external'}});
    expect(env).toMatchObject({META_API_KEY: 'opaque', SIFT_LOCAL_ONLY: '1', SIFT_WORKSPACE_ROOT: '/work', SIFT_USER_CWD: '/work'});
    for (const key of ['SIFT_PAT', 'SIFT_TOKEN', 'EXF_TOKEN', 'SIFT_WORKSPACE_ID', 'EXECUTERM_AUTO_APPROVE', 'EXECUTERM_OPENFUNCTION_PATH']) expect(env).not.toHaveProperty(key);
  });
});
