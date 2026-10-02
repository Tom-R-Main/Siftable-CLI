import {afterEach, describe, expect, it, vi} from 'vitest';
import {mockFetch, restoreFetch, runCommand} from './helpers/mock-api.js';

const grantId = '44444444-4444-4444-8444-444444444444';
const workItemId = '22222222-2222-4222-8222-222222222222';
const runnerId = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  restoreFetch();
  vi.unstubAllEnvs();
});

function install() {
  const fetch = mockFetch();
  fetch.on('GET', '/api/v1/compute/runners').reply(200, {runners: []});
  fetch.on('POST', '/api/v1/compute/requests').reply(202, {grant: {id: grantId}, approvalUrl: 'https://app/vault/approvals/x'});
  fetch.on('GET', `/api/v1/compute/grants/${grantId}`).reply(200, {id: grantId, state: 'active'});
  fetch.on('GET', '/api/v1/compute/grants').reply(200, {grants: [{id: grantId, state: 'active', runnerName: 'aws-runner', workItemId, expectedRevision: 2}]});
  fetch.on('POST', `/api/v1/compute/grants/${grantId}/start`).reply(202, {grant: {id: grantId}, dispatch: {id: 'd1'}});
  fetch.on('POST', `/api/v1/compute/grants/${grantId}/stop`).reply(202, {grant: {id: grantId}, stopRequested: true});
  fetch.install();
  return () => (global.fetch as unknown as {mock: {calls: unknown[][]}}).mock.calls;
}

describe('sift compute', () => {
  it('lists advertised runners for the personal scope by default', async () => {
    const calls = install();
    const result = await runCommand(['compute', 'runners', '--token', 'test-token', '--json']);
    expect(result.exitCode).toBe(0);
    const url = new URL(calls()[0][0] as string);
    expect(url.pathname).toBe('/api/v1/compute/runners');
    expect(url.searchParams.get('workspaceId')).toBe('personal');
  });

  it('sends the exact grant request payload with explicit idempotency key', async () => {
    const calls = install();
    const result = await runCommand([
      'compute', 'request', workItemId,
      '--runner', runnerId, '--revision', '2', '--purpose', 'run the task',
      '--idempotency-key', 'explicit-k1', '--token', 'test-token', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://app/vault/approvals/x');
    const init = calls()[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('explicit-k1');
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'personal', workItemId, expectedRevision: 2,
      runnerId, purpose: 'run the task', surface: 'cli',
    });
  });

  it('starts a grant only through the grant route with idempotency', async () => {
    const calls = install();
    const result = await runCommand(['compute', 'start', grantId, '--idempotency-key', 'k2', '--token', 'test-token', '--json']);
    expect(result.exitCode).toBe(0);
    const [url, init] = calls()[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/compute/grants/${grantId}/start`);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k2');
    expect(JSON.parse(init.body as string)).toEqual({workspaceId: 'personal', surface: 'cli'});
  });

  it('prints a grant table in normal mode and clean JSON in --json mode', async () => {
    install();
    const json = await runCommand(['compute', 'list', '--token', 'test-token', '--json']);
    expect(json.exitCode).toBe(0);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    const plain = await runCommand(['compute', 'list', '--token', 'test-token']);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toMatch(/ID|State/i);
  });

  it('prints grant detail and start/stop receipts in normal mode', async () => {
    install();
    const get = await runCommand(['compute', 'get', grantId, '--token', 'test-token']);
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toContain(grantId);
    const start = await runCommand(['compute', 'start', grantId, '--token', 'test-token']);
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toContain('d1');
    const stop = await runCommand(['compute', 'stop', grantId, '--token', 'test-token']);
    expect(stop.exitCode).toBe(0);
    expect(stop.stdout).toMatch(/stop/i);
  });

  it('has no compute approval command', async () => {
    install();
    const result = await runCommand(['compute', 'approve', grantId, '--token', 'test-token']);
    expect(result.exitCode).not.toBe(0);
    expect(result.error?.message ?? '').not.toContain('compute/requests');
  });

  describe('explicit personal scope suppresses ambient workspace', () => {
    const ambientOrg = '55555555-5555-4555-8555-555555555555';
    const cases: Array<{name: string; argv: string[]; method: 'GET' | 'POST'; path: string; scope: 'query' | 'body'}> = [
      {name: 'runners', argv: ['compute', 'runners'], method: 'GET', path: '/api/v1/compute/runners', scope: 'query'},
      {
        name: 'request', method: 'POST', path: '/api/v1/compute/requests', scope: 'body',
        argv: ['compute', 'request', workItemId, '--runner', runnerId, '--revision', '2', '--purpose', 'run the task'],
      },
      {name: 'list', argv: ['compute', 'list'], method: 'GET', path: '/api/v1/compute/grants', scope: 'query'},
      {name: 'get', argv: ['compute', 'get', grantId], method: 'GET', path: `/api/v1/compute/grants/${grantId}`, scope: 'query'},
      {name: 'start', argv: ['compute', 'start', grantId], method: 'POST', path: `/api/v1/compute/grants/${grantId}/start`, scope: 'body'},
      {name: 'stop', argv: ['compute', 'stop', grantId], method: 'POST', path: `/api/v1/compute/grants/${grantId}/stop`, scope: 'body'},
    ];

    for (const c of cases) {
      it(`${c.name} sends workspaceId=personal and no X-Workspace-Id under an ambient org`, async () => {
        const calls = install();
        vi.stubEnv('SIFT_WORKSPACE_ID', ambientOrg);
        const result = await runCommand([...c.argv, '--workspace', 'personal', '--token', 'test-token', '--json']);
        expect(result.exitCode).toBe(0);
        const [url, init] = calls()[0] as [string, RequestInit];
        expect(new URL(url).pathname).toBe(c.path);
        expect(new Headers(init.headers as HeadersInit).has('X-Workspace-Id')).toBe(false);
        const scoped = c.scope === 'query'
          ? new URL(url).searchParams.get('workspaceId')
          : (JSON.parse(init.body as string) as {workspaceId?: string}).workspaceId;
        expect(scoped).toBe('personal');
      });
    }

    it('honors an explicit org workspace override with header and body/query', async () => {
      const calls = install();
      const otherOrg = '66666666-6666-4666-8666-666666666666';
      vi.stubEnv('SIFT_WORKSPACE_ID', ambientOrg);
      const result = await runCommand([
        'compute', 'request', workItemId,
        '--runner', runnerId, '--revision', '2', '--purpose', 'run the task',
        '--workspace', otherOrg, '--token', 'test-token', '--json',
      ]);
      expect(result.exitCode).toBe(0);
      const [url, init] = calls()[0] as [string, RequestInit];
      expect(new URL(url).pathname).toBe('/api/v1/compute/requests');
      expect(new Headers(init.headers as HeadersInit).get('X-Workspace-Id')).toBe(otherOrg);
      expect((JSON.parse(init.body as string) as {workspaceId?: string}).workspaceId).toBe(otherOrg);
      const list = await runCommand(['compute', 'list', '--workspace', otherOrg, '--token', 'test-token', '--json']);
      expect(list.exitCode).toBe(0);
      const [lurl, linit] = calls()[1] as [string, RequestInit];
      expect(new URL(lurl).searchParams.get('workspaceId')).toBe(otherOrg);
      expect(new Headers(linit.headers as HeadersInit).get('X-Workspace-Id')).toBe(otherOrg);
    });
  });
});
