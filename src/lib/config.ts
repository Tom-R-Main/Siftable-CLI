import {readFileSync, writeFileSync, mkdirSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

export interface AuthConfig {
  token: string;
}

export function getConfigDir(): string {
  if (process.env.EXF_CONFIG_DIR) {
    return process.env.EXF_CONFIG_DIR;
  }

  const baseDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(baseDir, 'exf');
}

function getAuthFile(): string {
  return join(getConfigDir(), 'auth.json');
}

export function readConfig(): AuthConfig | null {
  try {
    const content = readFileSync(getAuthFile(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeConfig(config: AuthConfig): void {
  mkdirSync(getConfigDir(), {recursive: true, mode: 0o700});
  writeFileSync(getAuthFile(), JSON.stringify(config, null, 2), {mode: 0o600});
}

export function deleteConfig(): void {
  try {
    unlinkSync(getAuthFile());
  } catch {
    // Already gone
  }
}
