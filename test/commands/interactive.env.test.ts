import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildChildEnv, findBun, resolveTuiDir, resolveWorkspaceRoot} from '../../src/commands/interactive.js';

describe('sift interactive — launcher env', () => {
  describe('buildChildEnv', () => {
    const base = {
      token: 'sift_pat_abc123',
      apiUrl: 'https://siftable.io',
    };

    // IRON RULE: A0 has no mutating tool, so the spawned brain must NEVER inherit
    // an auto-approve flag. A stray inherited value cannot be allowed to grant
    // silent writes if write tools return in A1.
    it('scrubs an inherited EXECUTERM_AUTO_APPROVE', () => {
      const env = buildChildEnv({
        ...base,
        baseEnv: {EXECUTERM_AUTO_APPROVE: '1', PATH: '/usr/bin'},
      });
      expect(env.EXECUTERM_AUTO_APPROVE).toBeUndefined();
      expect('EXECUTERM_AUTO_APPROVE' in env).toBe(false);
    });

    it('scrubs AUTO_APPROVE even when set to an unexpected truthy value', () => {
      const env = buildChildEnv({
        ...base,
        baseEnv: {EXECUTERM_AUTO_APPROVE: 'yes-please', PATH: '/usr/bin'},
      });
      expect(env.EXECUTERM_AUTO_APPROVE).toBeUndefined();
    });

    it('sets the brain auth + transport contract (SIFT_PAT, SIFT_API_URL, SIFT_LOCAL_BRAIN)', () => {
      const env = buildChildEnv({...base, baseEnv: {}});
      expect(env.SIFT_PAT).toBe('sift_pat_abc123');
      expect(env.SIFT_API_URL).toBe('https://siftable.io');
      expect(env.SIFT_LOCAL_BRAIN).toBe('1');
    });

    it('includes SIFT_WORKSPACE_ID only when provided', () => {
      expect(buildChildEnv({...base, baseEnv: {}}).SIFT_WORKSPACE_ID).toBeUndefined();
      expect(
        buildChildEnv({...base, workspaceId: 'org-1', baseEnv: {}}).SIFT_WORKSPACE_ID,
      ).toBe('org-1');
    });

    it('passes the user cwd through as SIFT_USER_CWD', () => {
      const env = buildChildEnv({...base, userCwd: '/home/me/proj', baseEnv: {}});
      expect(env.SIFT_USER_CWD).toBe('/home/me/proj');
    });

    it('sets SIFT_WORKSPACE_ROOT from an explicit workspaceRoot and omits it when there is no cwd', () => {
      const withRoot = buildChildEnv({...base, workspaceRoot: '/repo', userCwd: '/repo/sub', baseEnv: {}});
      expect(withRoot.SIFT_WORKSPACE_ROOT).toBe('/repo');
      const noCwd = buildChildEnv({...base, baseEnv: {}});
      expect(noCwd.SIFT_WORKSPACE_ROOT).toBeUndefined();
    });

    it('uses the vendored OpenFunction runtime by default and honors an explicit dev override', () => {
      const def = buildChildEnv({...base, baseEnv: {HOME: '/home/me'}});
      expect(def.EXECUTERM_OPENFUNCTION_PATH).toBeUndefined();
      const override = buildChildEnv({
        ...base,
        openfunctionPath: '/custom/of/index.js',
        baseEnv: {HOME: '/home/me'},
      });
      expect(override.EXECUTERM_OPENFUNCTION_PATH).toBe('/custom/of/index.js');
    });

    it('does not mutate the passed baseEnv', () => {
      const baseEnv = {EXECUTERM_AUTO_APPROVE: '1', PATH: '/usr/bin'};
      buildChildEnv({...base, baseEnv});
      expect(baseEnv.EXECUTERM_AUTO_APPROVE).toBe('1'); // original untouched
    });
  });

  describe('resolveWorkspaceRoot', () => {
    it('walks up to the repo root containing .git', () => {
      const root = resolveWorkspaceRoot(__dirname);
      expect(existsSync(join(root, '.git'))).toBe(true);
    });

    it('falls back to the start dir when no .git ancestor exists', () => {
      expect(resolveWorkspaceRoot('/tmp')).toBe('/tmp');
    });
  });

  describe('findBun', () => {
    it('returns a path string or null (never throws)', () => {
      const result = findBun();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('resolveTuiDir', () => {
    it('locates interactive-tui/index.tsx walking up from the compiled command dir', () => {
      // src/commands at author time mirrors dist/commands at runtime: both are two
      // levels under the package root where interactive-tui lives.
      const fromSrc = resolveTuiDir(join(__dirname, '..', '..', 'src', 'commands'));
      expect(fromSrc).not.toBeNull();
      expect(fromSrc).toContain('interactive-tui');
    });

    it('returns null when no interactive-tui dir exists above the start', () => {
      expect(resolveTuiDir('/tmp')).toBeNull();
    });
  });
});
