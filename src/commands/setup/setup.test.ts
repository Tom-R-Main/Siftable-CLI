import {describe, expect, it, vi} from 'vitest';
import {describeSession, enrollCommand, linkMachineCommand, parseSetPairs, planPageUrl, type SetupSession} from '../../lib/setupSession.js';
import SetupContinue from './continue.js';
import SetupLinkMachine from './link-machine.js';
import SetupPrepare from './prepare.js';
import SetupStatus from './status.js';

const API = 'https://siftable.io';
const ID = '90000000-0000-4000-8000-0000000000a1';
const RUNNER = '90000000-0000-4000-8000-0000000000b2';
const session = (overrides: Partial<SetupSession> = {}, input: Record<string, unknown> = {}): SetupSession => ({
  id: ID, workspaceId: null, status: 'draft', currentVersion: 2, approvedVersion: null, workItemId: null,
  plan: {version: 2, input: {recipe: 'fix_failing_test', ...input}, provenance: {}, unmet: [{code: 'missing_value', field: 'machine.runnerId'}]},
  ...overrides,
});

type Ctor = {prototype: {run(): Promise<unknown>}};
async function run(ctor: Ctor, parsed: {args?: object; flags: object}, replies: unknown[], options: {json?: boolean; confirm?: boolean; resolved?: string} = {}) {
  const command = Object.create(ctor.prototype) as Record<string, unknown> & {run(): Promise<unknown>};
  const apiRequest = vi.fn();
  for (const reply of replies) apiRequest.mockResolvedValueOnce(reply);
  const log = vi.fn();
  const confirmAction = vi.fn().mockResolvedValue(options.confirm ?? false);
  Object.assign(command, {
    parse: vi.fn().mockResolvedValue({args: parsed.args ?? {}, flags: {'api-url': API, ...parsed.flags}}),
    apiRequest, log, confirmAction, jsonEnabled: () => options.json ?? false, workspaceId: (value?: string) => value ?? options.resolved,
    idempotencyKey: () => 'cli-key', error: (message: string) => { throw new Error(message); },
  });
  const result = await command.run();
  return {result, apiRequest, confirmAction, lines: log.mock.calls.map(([line]) => line as string)};
}

describe('setup session helpers', () => {
  it('parses --set pairs as JSON when they are JSON, and as text otherwise', () => {
    expect(parseSetPairs(['scope.write=["src"]', 'budget.writerMicros=2000000', 'baseSha=null', 'test.command=npm test -- a=b'])).toEqual({
      'scope.write': ['src'], 'budget.writerMicros': 2_000_000, baseSha: null, 'test.command': 'npm test -- a=b',
    });
    expect(() => parseSetPairs(['novalue'])).toThrow(/field=value/);
    expect(() => parseSetPairs(['=x'])).toThrow(/field=value/);
  });

  // Release U6-R8: commands printed for a workspace setup act in that workspace.
  it('names the setup\'s workspace in the enroll and link commands', () => {
    const ws = '90000000-0000-4000-8000-0000000000c3';
    // Personal is stated, so a saved selection or SIFT_WORKSPACE_ID cannot redirect the command.
    // The default API is stated too: the next process's SIFT_API_URL must not redirect the command.
    expect(enrollCommand(ID, null, API)).toBe(`sudo sift machine enroll --workspace personal --api-url ${API} --setup ${ID}`);
    expect(enrollCommand(ID, ws, API)).toBe(`sudo sift machine enroll --workspace ${ws} --api-url ${API} --setup ${ID}`);
    expect(linkMachineCommand(ID, RUNNER, null, API)).toBe(`sift setup link-machine ${ID} --runner ${RUNNER} --workspace personal --api-url ${API}`);
    expect(linkMachineCommand(ID, RUNNER, ws, API)).toBe(`sift setup link-machine ${ID} --runner ${RUNNER} --workspace ${ws} --api-url ${API}`);
    expect(enrollCommand(ID, ws, 'https://staging.siftable.io/')).toBe(`sudo sift machine enroll --workspace ${ws} --api-url https://staging.siftable.io --setup ${ID}`);
    expect(linkMachineCommand(ID, RUNNER, null, 'http://127.0.0.1:8080'))
      .toBe(`sift setup link-machine ${ID} --runner ${RUNNER} --workspace personal --api-url http://127.0.0.1:8080`);
    expect(describeSession(session({workspaceId: ws}), API))
      .toContain(`  machine.runnerId: enroll a Linux machine with \`sudo sift machine enroll --workspace ${ws} --api-url ${API} --setup ${ID}\``);
  });

  it('says what each unmet value needs and where to review the plan', () => {
    const lines = describeSession(session({}, {}), API);
    expect(lines[0]).toBe(`Setup ${ID}: draft, version 2`);
    expect(lines).toContain(`  machine.runnerId: enroll a Linux machine with \`sudo sift machine enroll --workspace personal --api-url ${API} --setup ${ID}\``);
    expect(lines.at(-1)).toBe(`Plan page: ${API}/app/setup/${ID}?workspace=personal`);
    expect(planPageUrl(`${API}/`, ID, null)).toBe(`${API}/app/setup/${ID}?workspace=personal`);
    expect(planPageUrl(API, ID, '90000000-0000-4000-8000-0000000000c3')).toBe(`${API}/app/setup/${ID}?workspace=90000000-0000-4000-8000-0000000000c3`);
    const ready = describeSession(session({status: 'ready', plan: {...session().plan, unmet: []}}), API);
    expect(ready).toContain('Nothing is missing. Review the plan and press Run on the plan page.');
    expect(describeSession(session({plan: {...session().plan, unmet: [{code: 'missing_configuration', field: 'review.image'}]}}), API))
      .toContain('  review.image: the server has no reviewer image configured; an operator must set it');
  });
});

describe('sift setup', () => {
  it('prepares a plan through the cli surface, defaulting the recipe, and returns the server body in JSON mode', async () => {
    const body = {session: session()};
    const {result, apiRequest, lines} = await run(SetupPrepare, {flags: {input: '{"repository":{"url":"https://github.com/acme/parser"}}', workspace: undefined}},
      [body], {json: true});
    expect(apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/setup/sessions', {
      method: 'POST', idempotencyKey: 'cli-key',
      // No --workspace and no saved selection: the server picks the user's only workspace.
      body: {surface: 'cli', input: {recipe: 'fix_failing_test', repository: {url: 'https://github.com/acme/parser'}}},
    });
    expect(result).toEqual(body);
    expect(lines).toEqual([]);
  });

  it('prepares in Personal context only when --workspace personal says so', async () => {
    const {apiRequest} = await run(SetupPrepare, {flags: {input: '{}', workspace: 'personal'}}, [{session: session()}]);
    expect(apiRequest.mock.calls[0][0]).toMatchObject({workspace: null});
    expect(apiRequest.mock.calls[0][2]).toMatchObject({body: {workspaceId: 'personal'}});
  });

  it('reuses a given key to retry a lost prepare, and names the workspace', async () => {
    const ws = '90000000-0000-4000-8000-0000000000c3';
    const {apiRequest, lines} = await run(SetupPrepare, {flags: {input: '{}', workspace: ws, 'idempotency-key': 'k-1'}}, [{session: session({workspaceId: ws})}]);
    expect(apiRequest.mock.calls[0][2]).toMatchObject({idempotencyKey: 'k-1', body: {workspaceId: ws}});
    expect(lines.at(-1)).toBe(`Plan page: ${API}/app/setup/${ID}?workspace=${ws}`);
  });

  // Release U6-R8: --workspace personal sends no workspace header and names personal in the body; no flag follows the saved selection.
  it('treats --workspace personal as no workspace, and otherwise uses the resolved selection', async () => {
    const personal = await run(SetupStatus, {args: {id: ID}, flags: {workspace: 'personal'}}, [{session: session()}]);
    expect(personal.apiRequest.mock.calls[0][0]).toMatchObject({workspace: null});
    expect(personal.apiRequest.mock.calls[0][1]).toBe(`/api/v1/setup/sessions/${ID}?workspaceId=personal`);
    const ws = '90000000-0000-4000-8000-0000000000c3';
    const saved = await run(SetupStatus, {args: {id: ID}, flags: {}}, [{session: session()}], {resolved: ws});
    expect(saved.apiRequest.mock.calls[0][0]).toMatchObject({workspace: ws});
    expect(saved.apiRequest.mock.calls[0][1]).toBe(`/api/v1/setup/sessions/${ID}?workspaceId=${ws}`);
  });

  it('reads a session in the workspace scope', async () => {
    const {apiRequest} = await run(SetupStatus, {args: {id: ID}, flags: {}}, [{session: session()}]);
    expect(apiRequest).toHaveBeenCalledWith(expect.anything(), `/api/v1/setup/sessions/${ID}?workspaceId=personal`);
  });

  it('continues against the version given, merging --changes and --set', async () => {
    const {apiRequest} = await run(SetupContinue, {args: {id: ID}, flags: {version: 2, changes: '{"title":"Fix"}', set: ['environment.install=npm']}},
      [{session: session({currentVersion: 3})}]);
    expect(apiRequest).toHaveBeenCalledWith(expect.anything(), `/api/v1/setup/sessions/${ID}/revisions`, {
      method: 'POST', idempotencyKey: 'cli-key',
      body: {workspaceId: 'personal', surface: 'cli', expectedVersion: 2, changes: {title: 'Fix', 'environment.install': 'npm'}},
    });
    await expect(run(SetupContinue, {args: {id: ID}, flags: {version: 2}}, [])).rejects.toThrow(/at least one change/);
  });

  it('links an enrolled machine with the machine source at the current version', async () => {
    const {apiRequest, confirmAction} = await run(SetupLinkMachine, {args: {id: ID}, flags: {runner: RUNNER}},
      [{session: session()}, {session: session({currentVersion: 3})}]);
    expect(confirmAction).not.toHaveBeenCalled();
    expect(apiRequest.mock.calls[1]).toEqual([expect.anything(), `/api/v1/setup/sessions/${ID}/revisions`, {
      method: 'POST', idempotencyKey: 'cli-key',
      body: {workspaceId: 'personal', surface: 'cli', expectedVersion: 2, changes: {'machine.runnerId': RUNNER},
        provenance: {'machine.runnerId': {source: 'machine', detail: 'enrolled with sift machine enroll'}}},
    }]);
  });

  it('asks before replacing a different runner, and changes nothing when refused or already linked', async () => {
    const other = {machine: {runnerId: '90000000-0000-4000-8000-0000000000d4'}};
    const refused = run(SetupLinkMachine, {args: {id: ID}, flags: {runner: RUNNER}}, [{session: session({}, other)}], {confirm: false});
    await expect(refused).rejects.toThrow('Not changed.');
    const {apiRequest} = await run(SetupLinkMachine, {args: {id: ID}, flags: {runner: RUNNER}}, [{session: session({}, other)}, {session: session()}], {confirm: true});
    expect(apiRequest).toHaveBeenCalledTimes(2);
    const same = await run(SetupLinkMachine, {args: {id: ID}, flags: {runner: RUNNER}}, [{session: session({}, {machine: {runnerId: RUNNER}})}]);
    expect(same.apiRequest).toHaveBeenCalledTimes(1);
    expect(same.lines).toEqual([`The plan already runs on ${RUNNER}.`]);
  });
});
