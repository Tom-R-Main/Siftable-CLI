import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { agentHarnessAsk, closeBrain, getAgent, setAgentConversationKey, __resetBrainAgentsForTests } from '../interactive-tui/brain';
import * as explorer from '../interactive-tui/explorer';


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('cancellation during deterministic preparation prevents auxiliary and main model admission', async () => {
  const saved = { explorer: process.env.SIFT_EXPLORER, mode: process.env.SIFT_EXPLORER_MODE, scout: process.env.SIFT_EXPLORER_SCOUT };
  process.env.SIFT_EXPLORER = '1'; process.env.SIFT_EXPLORER_MODE = 'fast-context'; process.env.SIFT_EXPLORER_SCOUT = '1';
  const prepared = deferred<any>();
  const reportMock = jest.spyOn(explorer, 'buildExplorerReport').mockReturnValue(prepared.promise);
  const createChatAgent = jest.fn();
  (globalThis as any).__SIFT_AGENT_HARNESS__ = { createChatAgent };
  const controller = new AbortController();
  try {
    const run = agentHarnessAsk('scour this repository and explain its architecture', () => {}, controller.signal);
    expect(reportMock).toHaveBeenCalled();
    controller.abort();
    prepared.resolve({});
    expect(await run).toMatchObject({ status: 'interrupted' });
    expect(createChatAgent).not.toHaveBeenCalled();
  } finally {
    for (const [name, value] of [['SIFT_EXPLORER', saved.explorer], ['SIFT_EXPLORER_MODE', saved.mode], ['SIFT_EXPLORER_SCOUT', saved.scout]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    reportMock.mockRestore();
    delete (globalThis as any).__SIFT_AGENT_HARNESS__; __resetBrainAgentsForTests();
  }
});

// Exercise the private production timeout helper, without exporting test-only
// runtime APIs or duplicating its implementation.
const source = ts.createSourceFile('brain.ts', readFileSync(join(__dirname, '../interactive-tui/brain.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['withTimeout', 'throwIfExplorerAborted']);
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && !!node.name && names.has(node.name.text));
const code = ts.transpileModule(functions.map((node) => node.getText(source)).join('\n'), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
function timeoutHarness() {
  const sandbox = createContext({ AbortController, DOMException, Error, setTimeout, clearTimeout });
  runInContext(code, sandbox);
  return sandbox.withTimeout as <T>(run: (signal: AbortSignal) => Promise<T>, timeout: number, parent?: AbortSignal) => Promise<T>;
}

test('an auxiliary deadline aborts supported work and waits for its settlement', async () => {
  const withTimeout = timeoutHarness();
  const settling = deferred<string>();
  const aborted = deferred<void>();
  let settled = false;
  const run = withTimeout((signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), {once: true});
    return settling.promise;
  }, 15).finally(() => { settled = true; });
  await aborted.promise;
  expect(settled).toBe(false);
  settling.resolve('late result');
  await expect(run).rejects.toThrow('timed out');
});

test('a cancelled auxiliary request is never admitted', async () => {
  const controller = new AbortController(); controller.abort();
  const operation = jest.fn(async () => 'unused');
  await expect(timeoutHarness()(operation, 100, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
  expect(operation).not.toHaveBeenCalled();
});

describe('truthful brain settlement', () => {
  const environmentKeys = ['SIFT_WORKSPACE_ROOT', 'SIFT_USER_CWD', 'SIFT_EXPLORER', 'SIFT_CONTEXT_COMPACTION', 'SIFT_SESSION_EVENT_ROOT', 'SIFT_INTERACTIVE_TUI_DIR'] as const;
  let savedEnvironment: Record<string, string | undefined>;
  let root: string;
  let createChatAgent: jest.Mock;

  beforeEach(async () => {
    savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    root = await realpath(await mkdtemp(join(tmpdir(), 'sift-brain-terminal-')));
    process.env.SIFT_WORKSPACE_ROOT = root;
    process.env.SIFT_USER_CWD = root;
    process.env.SIFT_INTERACTIVE_TUI_DIR = root;
    process.env.SIFT_SESSION_EVENT_ROOT = join(root, 'events');
    process.env.SIFT_CONTEXT_COMPACTION = '0';
    process.env.SIFT_EXPLORER = '0';
    createChatAgent = jest.fn(async () => ({chat: async function* () {}, close: jest.fn(async () => {})}));
    (globalThis as any).__SIFT_AGENT_HARNESS__ = {
      createChatAgent, defineTool: (tool: unknown) => tool,
      ok: (data: unknown) => ({success: true, data}), err: (error: string) => ({success: false, error}),
    };
    __resetBrainAgentsForTests();
  });

  afterEach(async () => {
    __resetBrainAgentsForTests();
    delete (globalThis as any).__SIFT_AGENT_HARNESS__;
    for (const key of environmentKeys) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
    await rm(root, {recursive: true, force: true});
  });

  test.each(['', 'partial answer'])('a stream ending without done fails and retains text %j', async text => {
    createChatAgent.mockImplementation(async () => ({chat: async function* () {
      if (text) yield {type: 'text', text};
    }}));
    const result = await agentHarnessAsk('hello', jest.fn());
    expect(result).toMatchObject({status: 'failed', text, error: 'Agent stream ended without a terminal result.'});
    expect(result.result).toBeUndefined();
  });

  test('cached-agent close failure is propagated only after all cached agents settle', async () => {
    const failure = new Error('durable close failed');
    const secondClosing = deferred<void>();
    const releaseSecond = deferred<void>();
    const firstClose = jest.fn(async () => { throw failure; });
    const secondClose = jest.fn(() => { secondClosing.resolve(); return releaseSecond.promise; });
    createChatAgent.mockResolvedValueOnce({close: firstClose}).mockResolvedValueOnce({close: secondClose});
    setAgentConversationKey('first'); await getAgent();
    setAgentConversationKey('second'); await getAgent();
    let settled = false;
    const closing = closeBrain().then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    await secondClosing.promise;
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseSecond.resolve();
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([failure]);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
