import { installIsolatedConfigDirHooks } from '../helpers/config-env';
import { restoreFetch, runCommand } from '../helpers/mock-api';

installIsolatedConfigDirHooks('sift-auth-scope-test-');

describe('auth login incremental scopes', () => {
  afterEach(() => {
    restoreFetch();
    jest.restoreAllMocks();
  });

  it('requests and displays only explicitly selected Vault scopes', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/auth/device')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'opaque-device-code',
            user_code: 'BCDF-GHJK',
            verification_uri: 'https://siftable.io/app/device',
            verification_uri_complete: 'https://siftable.io/app/device?code=BCDF-GHJK',
            expires_in: 900,
            interval: 0,
            scopes: ['projects:read', 'vault:metadata:read', 'vault:audit:read'],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'opaque-device-token',
          token_type: 'Bearer',
        }),
      } as Response;
    });

    const result = await runCommand([
      'auth', 'login', '--no-input',
      '--scope', 'vault:metadata:read',
      '--scope', 'vault:audit:read',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(requests[0].body).toEqual({
      scopes: ['vault:metadata:read', 'vault:audit:read'],
    });
    expect(result.stdout).toContain('vault:metadata:read');
    expect(result.stdout).toContain('vault:audit:read');
    expect(result.stdout).not.toContain('opaque-device-token');
  });

  it('requests and displays the four supported AI invocation scopes', async () => {
    const requested = [
      'ai:models:read',
      'ai:invoke',
      'ai:usage:read',
      'ai:connections:use',
    ];
    const requests: Array<{body?: unknown}> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith('/auth/device')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'opaque-device-code',
            user_code: 'BCDF-GHJK',
            verification_uri: 'https://siftable.io/app/device',
            verification_uri_complete: 'https://siftable.io/app/device?code=BCDF-GHJK',
            expires_in: 900,
            interval: 0,
            scopes: ['projects:read', ...requested],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'opaque-device-token',
          token_type: 'Bearer',
        }),
      } as Response;
    });

    const result = await runCommand([
      'auth', 'login', '--no-input',
      ...requested.flatMap(scope => ['--scope', scope]),
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(requests[0].body).toEqual({scopes: requested});
    for (const scope of requested) {
      expect(result.stdout).toContain(scope);
    }
    expect(result.stdout).not.toContain('opaque-device-token');
  });
});
