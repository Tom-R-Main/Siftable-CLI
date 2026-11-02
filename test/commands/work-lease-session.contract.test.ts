import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {dirname, join} from 'node:path';
import {readWorkLeaseSession} from '../../src/lib/work-lease-session';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

const workItemId = '22222222-2222-4222-8222-222222222222';
const claimOwner = 'codex:test';
const claimToken = 'synthetic-claim-token-never-render';
const claimExpiresAt = '2099-08-27T03:30:00.000Z';

const isolatedConfig = installIsolatedConfigDirHooks('sift-cli-work-session-contract-');

afterEach(() => {
  restoreFetch();
});

function claimResponse(): Record<string, unknown> {
  return {
    workItem: {
      id: workItemId,
      title: 'Exercise managed lease session',
      status: 'claimed',
      claimOwner,
      claimToken,
      claimExpiresAt,
    },
  };
}

function installClaimRoute() {
  return mockFetch()
    .on('POST', '/api/v1/work-items/claim')
    .body((body) => {
      const input = body as Record<string, unknown>;
      return input.workItemId === workItemId && input.claimOwner === claimOwner;
    })
    .reply(200, claimResponse());
}

function claimArguments(json = true): string[] {
  return [
    'work',
    'claim',
    workItemId,
    '--owner',
    claimOwner,
    '--token',
    'sift_pat_test',
    ...(json ? ['--json'] : []),
  ];
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
}

async function runCliProcess(
  args: string[],
  config: {
    configDir: string;
    legacyConfigDir: string;
    environment?: Record<string, string>;
  },
): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  const packageRoot = join(__dirname, '..', '..');
  const {FORCE_COLOR: _forceColor, ...environment} = process.env;
  const child = spawn(process.execPath, [join(packageRoot, 'bin', 'run.js'), ...args], {
    cwd: packageRoot,
    env: {
      ...environment,
      NO_COLOR: '1',
      SIFT_CONFIG_DIR: config.configDir,
      EXF_CONFIG_DIR: config.legacyConfigDir,
      ...config.environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [exitCode] = await once(child, 'close') as [number | null];
  return {exitCode, stdout: stdout.trim(), stderr: stderr.trim()};
}

describe('managed CLI work lease session contract', () => {
  it('returns a safe session descriptor without rendering the claim token', async () => {
    installClaimRoute().install();

    const result = await runCommand(claimArguments());
    const output = JSON.parse(result.stdout) as {
      workItem?: Record<string, unknown>;
      leaseSession?: Record<string, unknown>;
    };

    expect(result.exitCode).toBe(0);
    expect(output.workItem).toEqual(expect.objectContaining({
      id: workItemId,
      status: 'claimed',
    }));
    expect(output.workItem).not.toHaveProperty('claimToken');
    expect(output.leaseSession).toEqual(expect.objectContaining({
      workItemId,
      claimOwner,
      expiresAt: claimExpiresAt,
      workspaceId: null,
      state: 'active',
    }));
    expect(result.stdout).not.toContain(claimToken);
  });

  it('keeps plain-text claim output secret-free and gives the next command', async () => {
    installClaimRoute().install();

    const result = await runCommand(claimArguments(false));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Work item claimed: ${workItemId}`);
    expect(result.stdout).toContain(`Next: sift work start ${workItemId}`);
    expect(result.stdout).not.toContain('Claim token:');
    expect(result.stdout).not.toContain(claimToken);
  });

  it('journals resumable session state with restrictive filesystem modes', async () => {
    installClaimRoute().install();

    const result = await runCommand(claimArguments());
    expect(result.exitCode).toBe(0);

    const sessionFiles = (await readdir(isolatedConfig().configDir, {recursive: true}))
      .filter((name) => name.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);

    const sessionPath = join(isolatedConfig().configDir, sessionFiles[0]);
    expect((await stat(dirname(sessionPath))).mode & 0o777).toBe(0o700);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
  });

  it('treats a malformed session journal as unavailable', async () => {
    installClaimRoute().install();
    const result = await runCommand(claimArguments());
    expect(result.exitCode).toBe(0);

    const sessionFiles = (await readdir(isolatedConfig().configDir, {recursive: true}))
      .filter((name) => name.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    await writeFile(
      join(isolatedConfig().configDir, sessionFiles[0]),
      '{"truncated":',
      'utf8',
    );

    await expect(readWorkLeaseSession(workItemId)).resolves.toBeNull();
  });

  it('resolves lifecycle credentials after the claiming process exits', async () => {
    const requests: Array<{
      path: string;
      body: Record<string, unknown>;
      workspaceId: string | undefined;
    }> = [];
    const server = createServer(async (request, response) => {
      const path = request.url ?? '';
      const body = await requestBody(request);
      requests.push({
        path,
        body,
        workspaceId: request.headers['x-workspace-id'] as string | undefined,
      });
      if (request.method === 'POST' && path === '/api/v1/work-items/claim') {
        sendJson(response, 200, claimResponse());
        return;
      }
      if (request.method === 'POST' && path === `/api/v1/work-items/${workItemId}/start`) {
        const authorized = body.claimOwner === claimOwner
          && body.claimToken === claimToken
          && body.leaseSeconds === 900;
        sendJson(response, authorized ? 200 : 403, authorized ? {
          workItem: {
            id: workItemId,
            status: 'running',
            claimOwner,
            claimToken,
            claimExpiresAt,
          },
        } : {error: 'lease credentials did not match'});
        return;
      }
      if (request.method === 'POST' && path === `/api/v1/work-items/${workItemId}/release`) {
        const authorized = body.claimOwner === claimOwner && body.claimToken === claimToken;
        sendJson(response, authorized ? 200 : 403, authorized ? {
          workItem: {
            id: workItemId,
            status: 'queued',
          },
        } : {error: 'lease credentials did not match'});
        return;
      }
      sendJson(response, 404, {error: `Unexpected ${request.method} ${path}`});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const config = isolatedConfig();

    try {
      const claimed = await runCliProcess([
        ...claimArguments(),
        '--api-url',
        apiUrl,
        '--workspace',
        'workspace-a',
      ], config);
      expect(claimed).toEqual(expect.objectContaining({exitCode: 0}));

      const started = await runCliProcess([
        'work',
        'start',
        workItemId,
        '--lease',
        '900',
        '--token',
        'sift_pat_test',
        '--api-url',
        apiUrl,
        '--json',
      ], {
        ...config,
        environment: {SIFT_WORKSPACE_ID: 'workspace-b'},
      });

      expect(started).toEqual(expect.objectContaining({exitCode: 0}));
      expect(JSON.parse(started.stdout)).toEqual(expect.objectContaining({
        workItem: expect.objectContaining({id: workItemId, status: 'running'}),
      }));
      expect(started.stdout).not.toContain(claimToken);
      expect(requests.find((request) => request.path.endsWith('/start'))?.body)
        .toEqual(expect.objectContaining({claimOwner, claimToken, leaseSeconds: 900}));
      expect(requests.find((request) => request.path.endsWith('/start'))?.workspaceId)
        .toBe('workspace-a');

      const released = await runCommand([
        'work',
        'release',
        workItemId,
        '--owner',
        claimOwner,
        '--claim-token',
        claimToken,
        '--token',
        'sift_pat_test',
        '--api-url',
        apiUrl,
        '--json',
      ]);
      expect(released).toEqual(expect.objectContaining({exitCode: 0}));
      expect(released.stdout).not.toContain(claimToken);
      const remainingSessions = (await readdir(config.configDir, {recursive: true}))
        .filter((name) => name.endsWith('.json'));
      expect(remainingSessions).toHaveLength(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('releases a successful claim when the private session cannot be persisted', async () => {
    const sessionsPath = join(isolatedConfig().configDir, 'work-sessions');
    await mkdir(isolatedConfig().configDir, {recursive: true});
    await writeFile(sessionsPath, 'blocks creation of the session directory', 'utf8');

    let releaseAuthorized = false;
    installClaimRoute()
      .on('POST', `/api/v1/work-items/${workItemId}/release`)
      .body((body) => {
        const input = body as Record<string, unknown>;
        releaseAuthorized = input.claimOwner === claimOwner && input.claimToken === claimToken;
        return releaseAuthorized;
      })
      .reply(200, {workItem: {id: workItemId, status: 'queued'}})
      .install();

    const result = await runCommand(claimArguments());
    const calls = (global.fetch as ReturnType<typeof jest.fn>).mock.calls;

    expect(result.exitCode).not.toBe(0);
    expect(releaseAuthorized).toBe(true);
    expect(calls.some(([url]) => String(url).includes(
      `/api/v1/work-items/${workItemId}/release`,
    ))).toBe(true);
    expect(result.stdout).not.toContain(claimToken);
  });
});
