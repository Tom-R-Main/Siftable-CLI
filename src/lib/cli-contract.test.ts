import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Config} from '@oclif/core';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import Interactive, {buildChildEnv} from '../commands/interactive.js';
import AiInvoke from '../commands/ai/invoke.js';
import Commands, {commandTopics} from '../commands/commands.js';
import {BaseCommand, DEFAULT_API_URL} from './base-command.js';
import {writeSavedWorkspaceSelection} from './workspace-context.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));

const packageRoot = resolve(__dirname, '../..');
const model = {connectionId: 'fixture-connection', connectionName: 'Fixture', provider: 'openrouter', model: 'fixture-model', status: 'available'};
const response = {connectionId: model.connectionId, model: model.model, text: 'hello', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 2}};
let config: Config;
let configDir: string;
let previousExitCode: typeof process.exitCode;

beforeAll(async () => { config = await Config.load({root: packageRoot}); });
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  configDir = mkdtempSync(join(tmpdir(), 'sift-cli-contract-'));
  vi.stubEnv('SIFT_CONFIG_DIR', configDir);
  vi.stubEnv('EXF_CONFIG_DIR', configDir);
  for (const key of ['SIFT_API_URL', 'EXF_API_URL', 'SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID', 'SIFT_TOKEN', 'EXF_TOKEN', 'SIFT_PAT', 'EXF_PAT']) vi.stubEnv(key, '');
  vi.stubEnv('SIFT_INTERACTIVE_RUNTIME', 'source');
  vi.mocked(spawnSync).mockImplementation((command) => ({
    pid: 1, output: [], stderr: '', stdout: command === 'which' || command === 'where' ? process.execPath : '', status: 0, signal: null,
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawnSync).mockReset();
  process.exitCode = previousExitCode;
  rmSync(configDir, {recursive: true, force: true});
});

function hostedClient() {
  const client = {
    listAiModels: vi.fn().mockResolvedValue({statusCode: 200, data: {models: [model]}}),
    generateAi: vi.fn().mockResolvedValue({statusCode: 200, data: {response}}),
    generateAiStream: vi.fn(async function* () {
      yield {type: 'delta', text: 'hel'};
      yield {type: 'delta', text: 'lo'};
      yield {type: 'completed', finishReason: 'stop'};
    }),
  };
  vi.spyOn(BaseCommand.prototype as never, 'client' as never).mockResolvedValue(client as never);
  return client;
}

async function jsonRun(CommandClass: typeof BaseCommand, argv: string[]): Promise<unknown> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...values) => { lines.push(values.map(String).join(' ')); });
  await CommandClass.run([...argv, '--json'], {root: packageRoot});
  return JSON.parse(lines.join('\n'));
}

class ApiProbe extends BaseCommand {
  async run() {
    const {flags} = await this.parse(ApiProbe);
    return this.apiRequest(flags, '/fixture');
  }
}

describe('CLI context and output contracts', () => {
  it.each([
    {sift: '', legacy: '', flag: undefined, expected: DEFAULT_API_URL},
    {sift: 'https://primary.test', legacy: 'https://legacy.test', flag: undefined, expected: 'https://primary.test'},
    {sift: '', legacy: 'https://legacy.test', flag: undefined, expected: 'https://legacy.test'},
    {sift: 'https://primary.test', legacy: 'https://legacy.test', flag: 'https://flag.test', expected: 'https://flag.test'},
  ])('dispatches to the resolved endpoint: $expected', async ({sift, legacy, flag, expected}) => {
    vi.stubEnv('SIFT_API_URL', sift);
    vi.stubEnv('EXF_API_URL', legacy);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await new ApiProbe(['--token', 'fixture-token', ...(flag ? ['--api-url', flag] : [])], config).run();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${expected}/fixture`);
  });

  it.each([
    {argv: ['--connected-models'], expected: [model]},
    {argv: ['--model', model.model], expected: {selected: model}},
    {argv: ['--model', model.model, '--prompt', 'fixture'], expected: {selected: model, response}},
    {argv: ['--model', model.model, '--prompt', 'fixture', '--stream'], expected: {selected: model, response: {...response, usage: {inputTokens: null, outputTokens: null}}}},
  ])('emits a JSON result for $argv', async ({argv, expected}) => {
    hostedClient();
    expect(await jsonRun(Interactive, argv)).toEqual(expected);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([Interactive, AiInvoke])('preserves streamed delta bytes in %s', async CommandClass => {
    hostedClient();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { chunks.push(String(chunk)); return true; }) as never);
    await new CommandClass(['--connection', model.connectionId, '--model', model.model, '--prompt', 'fixture', '--stream'], config).run();
    expect(chunks.join('')).toBe('hello');
  });

  it.each(['', 'opaque-provider-fixture'])('opens the TUI without a hosted PAT, including provider setup state', async providerKey => {
    vi.stubEnv('OPENROUTER_API_KEY', providerKey);
    vi.stubEnv('SIFT_PAT', 'stale-inherited-pat');
    vi.stubEnv('EXF_PAT', 'stale-legacy-pat');
    await new Interactive([], config).run();
    const launch = vi.mocked(spawnSync).mock.calls.find(([command]) => command === process.execPath);
    expect(launch).toBeDefined();
    expect(launch?.[2]?.env).not.toHaveProperty('SIFT_PAT');
    expect(launch?.[2]?.env).not.toHaveProperty('EXF_PAT');
    expect(launch?.[2]?.env?.OPENROUTER_API_KEY).toBe(providerKey);
  });

  it('keeps hosted prompt invocation authenticated', async () => {
    await expect(new Interactive(['--model', 'fixture-model', '--prompt', 'hosted fixture'], config).run()).rejects.toThrow('No authentication token found');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('omits absent child PAT values and preserves an explicitly resolved token', () => {
    const baseEnv = {SIFT_PAT: 'stale', EXF_PAT: 'stale-legacy'};
    const noToken = buildChildEnv({apiUrl: 'https://fixture.test', baseEnv});
    expect(noToken).not.toHaveProperty('SIFT_PAT');
    expect(noToken).not.toHaveProperty('EXF_PAT');
    expect(Object.values(noToken)).not.toContain('undefined');
    const withToken = buildChildEnv({token: 'resolved-fixture-token', apiUrl: 'https://fixture.test', baseEnv});
    expect(withToken.SIFT_PAT).toBe('resolved-fixture-token');
    expect(withToken).not.toHaveProperty('EXF_PAT');
    expect(baseEnv).toEqual({SIFT_PAT: 'stale', EXF_PAT: 'stale-legacy'});
  });

  it('resolves a saved workspace for the TUI child', async () => {
    writeSavedWorkspaceSelection({workspaceId: 'saved-workspace', workspaceName: 'Fixture', selectedAt: new Date(0).toISOString()});
    await new Interactive(['--token', 'fixture-token'], config).run();
    const launch = vi.mocked(spawnSync).mock.calls.find(([command]) => command === process.execPath);
    expect(launch?.[2]).toMatchObject({env: {SIFT_WORKSPACE_ID: 'saved-workspace'}});
  });

  it('fails before launching when a workspace is a filesystem path', async () => {
    await expect(new Interactive(['--token', 'fixture-token', '--workspace', '/tmp/wrong-scope'], config).run()).rejects.toThrow('cannot be filesystem paths');
    expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === process.execPath)).toBe(false);
  });

  it.each([{argv: ['--no-input']}, {argv: ['--json']}, {argv: ['--no-input', '--json']}])('rejects a noninteractive TUI launch: $argv', async ({argv}) => {
    await expect(new Interactive(argv, config).run()).rejects.toThrow('requires interactive input');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports a signaled child as failure', async () => {
    vi.mocked(spawnSync).mockImplementation((command) => ({
      pid: 1, output: [], stderr: '', stdout: command === 'which' ? process.execPath : '',
      status: command === 'which' ? 0 : null, signal: command === 'which' ? null : 'SIGTERM',
    }) as never);
    await expect(new Interactive(['--token', 'fixture-token'], config).run()).rejects.toMatchObject({oclif: {exit: 143}});
  });

  it('reports an absent child terminal status as failure', async () => {
    vi.mocked(spawnSync).mockImplementation((command) => ({
      pid: 1, output: [], stderr: '', stdout: command === 'which' ? process.execPath : '', status: command === 'which' ? 0 : null, signal: null,
    }) as never);
    await expect(new Interactive(['--token', 'fixture-token'], config).run()).rejects.toThrow('without a terminal status');
  });
});

describe('CLI discovery contract', () => {
  it('discovers new command families automatically and excludes hidden-only families', () => {
    expect(commandTopics([{id: 'agent:run'}, {id: 'ai:list'}, {id: 'secret:debug', hidden: true}], [{name: 'agent', description: 'Run the agent'}]))
      .toEqual([{topic: 'agent', description: 'Run the agent'}, {topic: 'ai', description: 'ai commands'}]);
  });

  it('covers every visible loaded command family in machine output', async () => {
    const result = await jsonRun(Commands, []) as {topics: Array<{topic: string}>};
    const topics = result.topics.map(entry => entry.topic);
    for (const command of config.commands.filter(command => !command.hidden)) expect(topics).toContain(command.id.split(':')[0]);
    for (const topic of ['ai', 'context', 'billing', 'worker', 'codex', 'approvals', 'grants', 'workspaces']) expect(topics).toContain(topic);
  });
});
