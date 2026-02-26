import {resolve} from 'path';
import {existsSync, unlinkSync, mkdirSync, readFileSync} from 'fs';
import {homedir} from 'os';

const CONFIG_DIR = resolve(homedir(), '.config', 'exf');
const AUTH_FILE = resolve(CONFIG_DIR, 'auth.json');

// Save and restore any existing auth config
let savedConfig: string | null = null;

beforeAll(() => {
  if (existsSync(AUTH_FILE)) {
    savedConfig = readFileSync(AUTH_FILE, 'utf-8');
  }
});

afterAll(() => {
  if (savedConfig) {
    mkdirSync(CONFIG_DIR, {recursive: true});
    require('fs').writeFileSync(AUTH_FILE, savedConfig, {mode: 0o600});
  } else {
    try { unlinkSync(AUTH_FILE); } catch {}
  }
});

describe('auth commands', () => {
  describe('auth login', () => {
    it('stores token to config file', async () => {
      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'login', '--token', 'exf_pat_test123']);
      expect(result.stdout).toContain('Token stored');

      const config = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
      expect(config.token).toBe('exf_pat_test123');
    });

    it('returns JSON when --json is passed', async () => {
      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'login', '--token', 'exf_pat_test123', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.stored).toBe(true);
    });

    it('errors when no token provided', async () => {
      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'login']);
      expect(result.error).toBeDefined();
    });
  });

  describe('auth status', () => {
    it('reports authenticated when config file has token', async () => {
      mkdirSync(CONFIG_DIR, {recursive: true});
      require('fs').writeFileSync(AUTH_FILE, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Authenticated');
    });

    it('reports not authenticated when no token', async () => {
      try { unlinkSync(AUTH_FILE); } catch {}

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'status']);
      expect(result.stdout).toContain('Not authenticated');
    });

    it('returns JSON status', async () => {
      try { unlinkSync(AUTH_FILE); } catch {}

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'status', '--json']);
      const json = JSON.parse(result.stdout);
      expect(json.authenticated).toBe(false);
    });
  });

  describe('auth logout', () => {
    it('removes token from config file', async () => {
      mkdirSync(CONFIG_DIR, {recursive: true});
      require('fs').writeFileSync(AUTH_FILE, JSON.stringify({token: 'exf_pat_test'}), {mode: 0o600});

      const {runCommand} = require('../helpers/mock-api');
      const result = await runCommand(['auth', 'logout']);
      expect(result.stdout).toContain('Token removed');
      expect(existsSync(AUTH_FILE)).toBe(false);
    });
  });
});
