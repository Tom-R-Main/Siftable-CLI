import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BaseCommand, DEFAULT_API_URL} from '../lib/base-command.js';
import {resolveToken} from '../lib/auth.js';
import {getConfigDir} from '../lib/config.js';
import {renderDetail, renderTable} from '../lib/output.js';
import {looksLikeLocalPath, readSavedWorkspaceSelection} from '../lib/workspace-context.js';

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] || process.env[legacy];
}

function packageJsonPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '..', 'package.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return join(process.cwd(), 'packages/exf-cli/package.json');
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath(), 'utf8')) as {version?: string};
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export default class Doctor extends BaseCommand {
  static description = 'Diagnose local Siftable CLI configuration without printing secrets';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Doctor);
    const envTokenSource = process.env.SIFT_TOKEN ? 'SIFT_TOKEN' : (process.env.EXF_TOKEN ? 'EXF_TOKEN' : undefined);
    const hasFlagToken = Boolean(flags.token);
    const hasSavedToken = Boolean(resolveToken());
    const tokenSource = hasFlagToken ? 'flag' : (envTokenSource || (hasSavedToken ? `config file (${getConfigDir()}/auth.json)` : null));
    const apiUrl = flags['api-url'] || envValue('SIFT_API_URL', 'EXF_API_URL') || DEFAULT_API_URL;
    const envWorkspaceSource = process.env.SIFT_WORKSPACE_ID ? 'SIFT_WORKSPACE_ID' : (process.env.EXF_WORKSPACE_ID ? 'EXF_WORKSPACE_ID' : undefined);
    const savedWorkspace = readSavedWorkspaceSelection();
    const workspace = flags.workspace || envValue('SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID') || savedWorkspace?.workspaceId || null;
    const workspaceSource = flags.workspace ? 'flag' : (envWorkspaceSource || (savedWorkspace ? 'saved selection' : null));
    const workspaceIsPath = Boolean(workspace && looksLikeLocalPath(workspace));
    const manifestPath = join(packageJsonPath(), '..', 'oclif.manifest.json');

    const checks = [
      {
        name: 'auth',
        ok: Boolean(tokenSource),
        status: tokenSource ? `configured via ${tokenSource}` : 'missing token',
        next: tokenSource ? null : 'Run `sift auth login` or set SIFT_TOKEN.',
      },
      {
        name: 'api_url',
        ok: Boolean(apiUrl),
        status: apiUrl,
        next: null,
      },
      {
        name: 'workspace',
        ok: !workspaceIsPath,
        status: workspaceIsPath
          ? 'invalid: local filesystem path supplied as tenant ID'
          : workspace
            ? `configured via ${workspaceSource || 'unknown'}`
            : 'not set (Personal context)',
        next: workspaceIsPath
          ? 'Move the local path to --workspace-root; use an exact tenant ID with --workspace.'
          : workspace
            ? null
            : 'Run `sift workspaces list` when you want to select a collaborative workspace.',
      },
      {
        name: 'workspace_service_token_setup',
        ok: !workspaceIsPath,
        status: workspaceIsPath
          ? 'blocked by invalid workspace tenant value'
          : workspace
          ? tokenSource
            ? 'ready for workspace-scoped server integrations'
            : 'workspace selected; token missing'
          : 'not applicable (Personal context)',
        next: workspace && !tokenSource
          ? 'For server integrations, set a scoped token as SIFT_TOKEN and set SIFT_WORKSPACE_ID to the workspace org ID.'
          : null,
      },
      {
        name: 'manifest',
        ok: existsSync(manifestPath),
        status: existsSync(manifestPath) ? 'present' : 'not present in working tree',
        next: 'This is expected after local postpack; rebuild before relying on generated command metadata.',
      },
    ];

    const result = {
      ok: checks.every((check) => check.ok || check.name === 'manifest'),
      cli: {
        package: '@siftable/cli',
        version: readPackageVersion(),
      },
      apiUrl,
      workspace,
      workspaceSource,
      authenticated: Boolean(tokenSource),
      tokenSource,
      tokenEnv: {
        SIFT_TOKEN: Boolean(process.env.SIFT_TOKEN),
        EXF_TOKEN: Boolean(process.env.EXF_TOKEN),
      },
      workspaceEnv: {
        SIFT_WORKSPACE_ID: Boolean(process.env.SIFT_WORKSPACE_ID),
        EXF_WORKSPACE_ID: Boolean(process.env.EXF_WORKSPACE_ID),
      },
      checks,
      next: [
        workspace
          ? 'For server integrations, map the secret value to SIFT_TOKEN and set SIFT_WORKSPACE_ID.'
          : 'Personal context is ready without SIFT_WORKSPACE_ID.',
        'Run `sift commands --json` to inspect command topics.',
        'Run `sift capabilities --json` to inspect readiness.',
        'Run `sift recipes list --json` to choose a research workflow.',
      ],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Package', result.cli.package],
        ['Version', result.cli.version],
        ['API URL', apiUrl],
        ['Workspace', workspace ? `${workspace} (${workspaceSource || 'unknown'})` : 'not set'],
        ['Authenticated', result.authenticated ? 'yes' : 'no'],
        ['Token source', tokenSource || 'not set'],
      ]);
      this.log('');
      renderTable(checks as unknown as Record<string, unknown>[], [
        {key: 'name', header: 'Check'},
        {key: 'ok', header: 'OK', get: (row) => row.ok ? 'yes' : 'no'},
        {key: 'status', header: 'Status'},
        {key: 'next', header: 'Next'},
      ]);
    }

    if (!result.ok) process.exitCode = 1;

    return result;
  }
}
