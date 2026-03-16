import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

export function installIsolatedConfigDirHooks(prefix = 'exf-cli-test-'): () => {
  configDir: string;
  authFile: string;
} {
  const originalConfigDir = process.env.EXF_CONFIG_DIR;
  let configDir = '';

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), prefix));
    process.env.EXF_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.EXF_CONFIG_DIR;
    } else {
      process.env.EXF_CONFIG_DIR = originalConfigDir;
    }

    if (configDir) {
      rmSync(configDir, {recursive: true, force: true});
      configDir = '';
    }
  });

  return () => ({
    configDir,
    authFile: join(configDir, 'auth.json'),
  });
}
