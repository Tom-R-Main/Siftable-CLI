import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

// Execute the actual TUI handlers with renderer/signal dependencies injected.
// Importing index.tsx itself starts OpenTUI's native renderer; AST extraction
// keeps these lifecycle tests deterministic without copying implementation.
const source = ts.createSourceFile('index.tsx', readFileSync(join(__dirname, '../interactive-tui/index.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(['onEnter', 'drainNextQueued', 'runShell', 'submitOne']);
const definitions: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) definitions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (definitions.length !== names.size) throw new Error('TUI handler extraction failed');
const code = ts.transpileModule(definitions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let busy = false;
  let queue: any[] = [];
  let input = '';
  let status = '';
  const messages: any[] = [];
  const sandbox: any = {
    AbortController, DOMException, Error, setTimeout, clearTimeout, process: { env: {} },
    quitRequested: false, abortController: null,
    busy: () => busy, setBusy: (value: boolean) => { busy = value; },
    queued: () => queue, setQueued: (value: any) => { queue = typeof value === 'function' ? value(queue) : value; },
    input: () => input, setText: (value: string) => { input = value; },
    setStatus: (value: string) => { status = value; },
    messages, push: (value: any) => messages.push(value),
    setMessages: (index: number, field: string, value: any) => { messages[index][field] = typeof value === 'function' ? value(messages[index][field]) : value; },
    renderer: { isDestroyed: false, destroy: jest.fn() },
    history: [], histIndex: 0, setTranscriptSelected: jest.fn(), clearUsedPasteChips: jest.fn(),
    buildChatInput: (text: string) => text, handleSlash: jest.fn(),
    getSessionCwd: () => '/workspace', getWorkspaceRoot: () => '/workspace',
    setSessionCwd: jest.fn(), randomUUID: () => 'id', playSound: jest.fn(),
    commandCtx: () => ({}), ensureExplorerProviderKey: jest.fn(async () => undefined),
    renderSkillPreflight: jest.fn(async () => ({})), discoverSkills: () => [], apiClient: {},
    appendSkillPreflightContext: (text: string) => text,
    ToolRowTracker: class { drain() { return []; } },
    client: { send: jest.fn(async () => undefined) },
    autoRenderMermaid: jest.fn(), STREAMING_TEXT_FLUSH_MS: 5,
    runSupervisedShell: jest.fn(),
  };
  const context = createContext(sandbox);
  runInContext(code, context);
  return { sandbox, context, busy: () => busy, queue: () => queue, status: () => status, messages };
}

test('admission precedes preflight: repeated Enter queues and quit cannot launch a late turn', async () => {
  const h = harness();
  const preflight = deferred<undefined>();
  h.sandbox.ensureExplorerProviderKey.mockReturnValue(preflight.promise);
  const pending = h.sandbox.submitOne('first');
  expect(h.busy()).toBe(true);
  h.sandbox.setText('second');
  h.sandbox.onEnter();
  expect(h.queue()).toEqual([{ sendInput: 'second', displayText: 'second' }]);
  h.sandbox.quitRequested = true;
  h.sandbox.abortController.abort();
  expect(h.sandbox.renderer.destroy).not.toHaveBeenCalled();
  preflight.resolve(undefined);
  await pending;
  expect(h.sandbox.renderSkillPreflight).not.toHaveBeenCalled();
  expect(h.sandbox.client.send).not.toHaveBeenCalled();
  expect(h.busy()).toBe(false);
  expect(h.sandbox.renderer.destroy).toHaveBeenCalledTimes(1);
  expect(h.queue()).toHaveLength(1);
});

test('cancel during skill preflight fences model dispatch and preserves queued commands', async () => {
  const h = harness();
  const preflight = deferred<{}>();
  h.sandbox.renderSkillPreflight.mockReturnValue(preflight.promise);
  const pending = h.sandbox.submitOne('first');
  await Promise.resolve();
  h.sandbox.setText('!echo later'); h.sandbox.onEnter();
  expect(h.queue()[0].shellCommand).toBe('echo later');
  h.sandbox.abortController.abort();
  preflight.resolve({});
  await pending;
  expect(h.sandbox.client.send).not.toHaveBeenCalled();
  expect(h.sandbox.runSupervisedShell).not.toHaveBeenCalled();
  expect(h.queue()).toHaveLength(1);
});

test('human shell stays busy until supervised settlement and quits only afterward', async () => {
  const h = harness();
  const shell = deferred<any>();
  h.sandbox.runSupervisedShell.mockReturnValue(shell.promise);
  const pending = h.sandbox.runShell('sleep 30');
  expect(h.busy()).toBe(true);
  const callContext = h.sandbox.runSupervisedShell.mock.calls[0][2].context;
  expect(callContext).toMatchObject({ workspaceRoot: '/workspace', sessionCwd: '/workspace' });
  h.sandbox.quitRequested = true;
  h.sandbox.abortController.abort();
  expect(callContext.signal.aborted).toBe(true);
  expect(h.sandbox.renderer.destroy).not.toHaveBeenCalled();
  expect(h.busy()).toBe(true);
  shell.resolve({ output: '', exitCode: null, cancelled: true, executionOutcome: 'unknown', terminationConfirmed: true });
  await pending;
  expect(h.sandbox.renderer.destroy).toHaveBeenCalledTimes(1);
  expect(h.busy()).toBe(false);
  expect(h.messages.at(-1).text).toContain('interrupted');
});

test('queued human commands retain shell dispatch rather than becoming model prompts', async () => {
  const h = harness();
  h.sandbox.setQueued([{ sendInput: '!echo ok', displayText: '!echo ok', shellCommand: 'echo ok' }]);
  h.sandbox.runSupervisedShell.mockResolvedValue({ output: 'ok', exitCode: 0, executionOutcome: 'succeeded', terminationConfirmed: true });
  h.sandbox.drainNextQueued();
  await Promise.resolve();
  expect(h.sandbox.runSupervisedShell).toHaveBeenCalledWith('echo ok', '/workspace', expect.any(Object));
  expect(h.sandbox.client.send).not.toHaveBeenCalled();
  expect(h.queue()).toHaveLength(0);
});
