import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'fs';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';

const getConfigPaths = installIsolatedConfigDirHooks('exf-cli-auth-test-');

describe('auth commands', () => {
  describe('auth login', () => {
    it('stores token to config file', async () => {
      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'login', '--token', 'exf_pat_test123']);
      expect(result.stdout).toContain('Token stored');

      const {authFile} = getConfigPaths();
      const config = JSON.parse(readFileSync(authFile, 'utf-8'));
      expect(config.token).toBe('exf_pat_test123');
    });

    it('returns JSON when --json is passed', async () => {
      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'login', '--token', 'exf_pat_test123', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.stored).toBe(true);
    });

  });

  describe('auth status', () => {
    it('reports authenticated when config file has token', async () => {
      const {configDir, authFile} = getConfigPaths();
      mkdirSync(configDir, {recursive: true});
      writeFileSync(authFile, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Authenticated');
    });

    it('reports not authenticated when no token', async () => {
      const {authFile} = getConfigPaths();
      try { unlinkSync(authFile); } catch {}

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Not authenticated');
    });

    it('returns JSON status', async () => {
      const {authFile} = getConfigPaths();
      try { unlinkSync(authFile); } catch {}

      const {runCommand} = require('../helpers/mock-api');
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

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'logout']);
      expect(result.stdout).toContain('Token removed');
      expect(existsSync(authFile)).toBe(false);
    });
  });
});
