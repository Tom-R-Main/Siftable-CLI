import {Command, Flags} from '@oclif/core';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ExfClient} from '@execufunction/mcp-server/dist/exfClient.js';
import {resolveToken} from './auth.js';
import {confirm} from './output.js';

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true;

  static baseFlags = {
    token: Flags.string({
      description: 'Personal access token',
      env: 'EXF_TOKEN',
      helpGroup: 'GLOBAL',
    }),
    'api-url': Flags.string({
      description: 'API base URL',
      env: 'EXF_API_URL',
      default: 'https://execufunction.com',
      helpGroup: 'GLOBAL',
    }),
    'no-input': Flags.boolean({
      description: 'Disable interactive prompts',
      helpGroup: 'GLOBAL',
    }),
  };

  protected async client(flags: {token?: string; 'api-url'?: string}): Promise<ExfClient> {
    const token = flags.token || resolveToken();
    if (!token) {
      this.error('No authentication token found. Run `exf auth login` or set EXF_TOKEN.');
    }

    return new ExfClient({
      apiUrl: flags['api-url'] || 'https://execufunction.com',
      pat: token,
    });
  }

  protected unwrapList(response: {data?: unknown}, key: string): Record<string, unknown>[] {
    const data = response.data as Record<string, unknown> | undefined;
    return (data?.[key] ?? []) as Record<string, unknown>[];
  }

  protected unwrapOne(response: {data?: unknown}, key: string): Record<string, unknown> {
    const data = response.data as Record<string, unknown> | undefined;
    return (data?.[key] ?? data ?? {}) as Record<string, unknown>;
  }

  protected handleApiError(response: {statusCode: number; error?: string; data?: unknown}): void {
    if (response.error) {
      if (response.statusCode === 401) {
        this.error(`Authentication failed: ${response.error}\nRun \`exf auth login\` to authenticate.`);
      }

      if (response.statusCode === 403) {
        this.error(`Permission denied: ${response.error}`);
      }

      if (response.statusCode === 404) {
        this.error(`Not found: ${response.error}`);
      }

      if (response.statusCode === 429) {
        this.error(`Rate limited: ${response.error}\nPlease try again shortly.`);
      }

      this.error(`API error (${response.statusCode}): ${response.error}`);
    }
  }

  protected async confirmAction(
    message: string,
    flags: {yes?: boolean; 'no-input'?: boolean},
  ): Promise<boolean> {
    if (flags.yes) return true;
    if (flags['no-input']) {
      this.error(`${message} Use --yes to confirm in non-interactive mode.`);
    }

    return confirm(message);
  }

  protected idempotencyKey(): string {
    return `cli-${Date.now()}-${randomUUID()}`;
  }

  protected parseJsonFlag<T>(value: string | undefined, label: string): T | undefined {
    if (!value) {
      return undefined;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      this.error(`Invalid ${label} JSON.`);
    }
  }

  protected parseJsonInput<T>(
    value: string | undefined,
    filePath: string | undefined,
    label: string,
  ): T | undefined {
    if (!value && !filePath) {
      return undefined;
    }

    if (value && filePath) {
      this.error(`Provide either ${label} JSON inline or ${label} file path, not both.`);
    }

    const raw = filePath ? readFileSync(filePath, 'utf8') : value!;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.error(`Invalid ${label} JSON${filePath ? ` in ${filePath}` : ''}.`);
    }
  }
}
