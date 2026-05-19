import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BaseCommand} from '../lib/base-command.js';
import {resolveToken} from '../lib/auth.js';
import {getConfigDir} from '../lib/config.js';
import {renderDetail, renderTable} from '../lib/output.js';

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
    const apiUrl = flags['api-url'] || envValue('SIFT_API_URL', 'EXF_API_URL') || 'https://execufunction.com';
    const workspace = flags.workspace || envValue('SIFT_WORKSPACE_ID', 'EXF_WORKSPACE_ID') || null;
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
        ok: Boolean(workspace),
        status: workspace || 'not set',
        next: workspace ? null : 'Set --workspace or SIFT_WORKSPACE_ID when operating in a specific workspace.',
      },
      {
        name: 'manifest',
        ok: existsSync(manifestPath),
        status: existsSync(manifestPath) ? 'present' : 'not present in working tree',
        next: 'This is expected after local postpack; rebuild before relying on generated command metadata.',
      },
    ];

    const result = {
      ok: checks.every((check) => check.ok || check.name === 'workspace' || check.name === 'manifest'),
      cli: {
        package: '@siftable/cli',
        version: readPackageVersion(),
      },
      apiUrl,
      workspace,
      authenticated: Boolean(tokenSource),
      tokenSource,
      checks,
      next: [
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
        ['Workspace', workspace],
        ['Authenticated', result.authenticated ? 'yes' : 'no'],
      ]);
      this.log('');
      renderTable(checks as unknown as Record<string, unknown>[], [
        {key: 'name', header: 'Check'},
        {key: 'ok', header: 'OK', get: (row) => row.ok ? 'yes' : 'no'},
        {key: 'status', header: 'Status'},
        {key: 'next', header: 'Next'},
      ]);
    }

    return result;
  }
}
