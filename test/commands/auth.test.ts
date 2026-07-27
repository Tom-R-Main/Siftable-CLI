import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'fs';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {runCommand} from '../helpers/mock-api';

const getConfigPaths = installIsolatedConfigDirHooks('exf-cli-auth-test-');

describe('auth commands', () => {
  describe('auth login', () => {
    it('stores token to config file', async () => {
      const result = await runCommand(['auth', 'login', '--token', 'sift_pat_test123']);
      expect(result.stdout).toContain('Token stored');

      const {authFile} = getConfigPaths();
      const config = JSON.parse(readFileSync(authFile, 'utf-8'));
      expect(config.token).toBe('sift_pat_test123');
    });

    it('returns JSON when --json is passed', async () => {
      const result = await runCommand(['auth', 'login', '--token', 'sift_pat_test123', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.stored).toBe(true);
    });

    it('starts device flow on the canonical Siftable API host', async () => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === 'string' ? input : input.toString());
        if (url.pathname === '/auth/device') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              device_code: 'device-123',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://siftable.io/app/device',
              verification_uri_complete: 'https://siftable.io/app/device?code=ABCD-EFGH',
              expires_in: 900,
              interval: 0,
              scopes: ['projects:read'],
            }),
          } as Response;
        }

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'sift_pat_device', token_type: 'Bearer' }),
        } as Response;
      }) as jest.Mock;

      const result = await runCommand(['auth', 'login', '--no-input']);

      expect(result.exitCode).toBe(0);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://siftable.io/auth/device',
        expect.objectContaining({ method: 'POST' }),
      );
    });

  });

  describe('auth status', () => {
    it('reports authenticated when config file has token', async () => {
      const {configDir, authFile} = getConfigPaths();
      mkdirSync(configDir, {recursive: true});
      writeFileSync(authFile, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Authenticated');
    });

    it('reads legacy config when new config is missing', async () => {
      const {legacyConfigDir, legacyAuthFile} = getConfigPaths();
      mkdirSync(legacyConfigDir, {recursive: true});
      writeFileSync(legacyAuthFile, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Authenticated');
    });

    it('reports not authenticated when no token', async () => {
      const {authFile} = getConfigPaths();
      try { unlinkSync(authFile); } catch {}

      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Not authenticated');
    });

    it('returns JSON status', async () => {
      const {authFile} = getConfigPaths();
      try { unlinkSync(authFile); } catch {}

      const result = await runCommand(['auth', 'status', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.authenticated).toBe(false);
    });
  });

  describe('auth logout', () => {
    it('removes token from config file', async () => {
      const {configDir, authFile} = getConfigPaths();
      mkdirSync(configDir, {recursive: true});
      writeFileSync(authFile, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const result = await runCommand(['auth', 'logout']);
      expect(result.stdout).toContain('Token removed');
      expect(existsSync(authFile)).toBe(false);
    });
  });
});
