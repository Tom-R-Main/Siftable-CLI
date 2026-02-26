import {readConfig, writeConfig, deleteConfig} from './config.js';

/**
 * Resolve token from config file.
 * Note: flag and env var resolution are handled by oclif's Flags.string({ env: 'EXF_TOKEN' }).
 * This function is the final fallback — reads from ~/.config/exf/auth.json.
 */
export function resolveToken(): string | undefined {
  const config = readConfig();
  return config?.token;
}

export function storeToken(token: string): void {
  writeConfig({token});
}

export function clearToken(): void {
  deleteConfig();
}
