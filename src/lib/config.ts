import {readFileSync, writeFileSync, mkdirSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const CONFIG_DIR = join(homedir(), '.config', 'exf');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

export interface AuthConfig {
  token: string;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function readConfig(): AuthConfig | null {
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function writeConfig(config: AuthConfig): void {
  mkdirSync(CONFIG_DIR, {recursive: true, mode: 0o700});
  writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), {mode: 0o600});
}

export function deleteConfig(): void {
  try {
    unlinkSync(AUTH_FILE);
  } catch {
    // Already gone
  }
}
