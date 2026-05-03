import {readConfig, writeConfig, deleteConfig} from './config.js';

/**
 * Resolve token from config file.
 * Note: flag and env var resolution is handled by BaseCommand so SIFT_* can
 * take precedence while legacy EXF_* remains supported.
 * This function is the final fallback — reads from the configured auth file.
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
