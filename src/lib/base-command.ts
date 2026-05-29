import {Command, Flags} from '@oclif/core';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {SiftClient} from '@siftable/mcp-server/dist/exfClient.js';
import {resolveToken} from './auth.js';
import {confirm} from './output.js';

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] || process.env[legacy];
}

export const DEFAULT_API_URL = 'https://siftable.io';

export abstract class BaseCommand extends Command {
  static enableJsonFlag = true;

  static baseFlags = {
    token: Flags.string({
      description: 'Personal access token',
      helpGroup: 'GLOBAL',
    }),
    'api-url': Flags.string({
      description: 'API base URL',
      default: DEFAULT_API_URL,
      helpGroup: 'GLOBAL',
    }),
    'no-input': Flags.boolean({
      description: 'Disable interactive prompts',
      helpGroup: 'GLOBAL',
    }),
    workspace: Flags.string({
      description: 'Workspace org ID to scope operations to',
      helpGroup: 'GLOBAL',
    }),
  };

  protected async client(flags: {token?: string; 'api-url'?: string; workspace?: string}): Promise<SiftClient> {
    const token = flags.token || envValue('SIFT_TOKEN', 'EXF_TOKEN') || resolveToken();
    if (!token) {
      this.error('No authentication token found. Run `sift auth login` or set SIFT_TOKEN.');
    }

    return new SiftClient({
      apiUrl: flags['api-url'] || envValue('SIFT_API_URL', 'EXF_API_URL') || DEFAULT_API_URL,
      pat: token,
      workspaceId: flags.workspace || envValue('SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID'),
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

  private parseApiError(error?: string): {
    message: string;
    raw: string;
    payload?: Record<string, unknown>;
  } {
    if (!error) {
      return {message: 'Unknown API error', raw: ''};
    }

    try {
      const payload = JSON.parse(error) as Record<string, unknown>;
      const title = typeof payload.title === 'string' ? payload.title : undefined;
      const detail = typeof payload.detail === 'string' ? payload.detail : undefined;
      const message = [title, detail].filter(Boolean).join(': ')
        || (typeof payload.message === 'string' ? payload.message : undefined)
        || (typeof payload.error === 'string' ? payload.error : undefined)
        || error;
      return {message, raw: error, payload};
    } catch {
      return {message: error, raw: error};
    }
  }

  private apiErrorSuggestions(payload?: Record<string, unknown>): string[] | undefined {
    switch (payload?.type) {
      case 'workspace_token_mismatch':
        return [
          'Check --workspace or SIFT_WORKSPACE_ID; it must match the workspace bound to this service token.',
          'Unset SIFT_WORKSPACE_ID to use the workspace service token default when the command does not need an override.',
        ];
      case 'insufficient_pat_scope':
        return [
          'Create or rotate the workspace service token with the required scope.',
          'Use tasks:read/tasks:write for task commands and work:read/work:write for work commands.',
        ];
      default:
        return undefined;
    }
  }

  private apiErrorMessage(statusCode: number, parsed: {message: string; payload?: Record<string, unknown>}): string {
    switch (parsed.payload?.type) {
      case 'workspace_token_mismatch':
        return `Workspace mismatch: ${parsed.message}`;
      case 'insufficient_pat_scope':
        return `Insufficient token scope: ${parsed.message}`;
      default:
        if (statusCode === 403) return `Permission denied: ${parsed.message}`;
        return parsed.message;
    }
  }

  protected override toErrorJson(err: Error & {
    oclif?: {exit?: number};
    code?: string;
    statusCode?: number;
    suggestions?: string[];
    api?: Record<string, unknown>;
  }): unknown {
    return {
      error: {
        message: err.message,
        code: err.code,
        statusCode: err.statusCode,
        api: err.api,
        exit: err.oclif?.exit ?? 1,
        suggestions: err.suggestions,
      },
    };
  }

  protected handleApiError(response: {statusCode: number; error?: string; data?: unknown}): void {
    if (response.error) {
      const parsed = this.parseApiError(response.error);

      if (response.statusCode === 401) {
        this.error(`Authentication failed: ${parsed.message}\nRun \`sift auth login\` to authenticate.`);
      }

      if (response.statusCode === 404) {
        this.error(`Not found: ${parsed.message}`);
      }

      if (response.statusCode === 429) {
        this.error(`Rate limited: ${parsed.message}\nPlease try again shortly.`);
      }

      if (parsed.payload) {
        const error = new Error(parsed.message) as Error & {
          code?: string;
          statusCode?: number;
          api?: Record<string, unknown>;
          suggestions?: string[];
        };
        error.message = this.apiErrorMessage(response.statusCode, parsed);
        error.code = parsed.payload.type as string | undefined;
        error.statusCode = response.statusCode;
        error.api = parsed.payload;
        error.suggestions = this.apiErrorSuggestions(parsed.payload);
        this.error(error, {exit: response.statusCode});
      }

      if (response.statusCode === 403) {
        this.error(`Permission denied: ${parsed.message}`);
      }

      const error = new Error(`API error (${response.statusCode}): ${parsed.message}`) as Error & {
        statusCode?: number;
      };
      error.statusCode = response.statusCode;
      this.error(error, {exit: response.statusCode});
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
