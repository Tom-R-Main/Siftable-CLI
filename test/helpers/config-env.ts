import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

export function installIsolatedConfigDirHooks(prefix = 'exf-cli-test-'): () => {
  configDir: string;
  legacyConfigDir: string;
  authFile: string;
  legacyAuthFile: string;
} {
  const originalSiftConfigDir = process.env.SIFT_CONFIG_DIR;
  const originalExfConfigDir = process.env.EXF_CONFIG_DIR;
  let configDir = '';
  let legacyConfigDir = '';

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), prefix));
    legacyConfigDir = mkdtempSync(join(tmpdir(), `${prefix}legacy-`));
    process.env.SIFT_CONFIG_DIR = configDir;
    process.env.EXF_CONFIG_DIR = legacyConfigDir;
  });

  afterEach(() => {
    if (originalSiftConfigDir === undefined) {
      delete process.env.SIFT_CONFIG_DIR;
    } else {
      process.env.SIFT_CONFIG_DIR = originalSiftConfigDir;
    }

    if (originalExfConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalExfConfigDir;
    }

    if (configDir) {
      rmSync(configDir, {recursive: true, force: true});
      configDir = '';
    }
    if (legacyConfigDir) {
      rmSync(legacyConfigDir, {recursive: true, force: true});
      legacyConfigDir = '';
    }
  });

  return () => ({
    configDir,
    legacyConfigDir,
    authFile: join(configDir, 'auth.json'),
    legacyAuthFile: join(legacyConfigDir, 'auth.json'),
  });
}
