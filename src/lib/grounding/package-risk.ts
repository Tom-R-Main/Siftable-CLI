import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {errorResult, EvidenceResult, nowIso} from './types.js';

export interface PackageRiskInput {
  packageName: string;
  projectRoot?: string;
}

export interface PackageRiskSignals extends Record<string, unknown> {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  declaredDependency: string | null;
  declaredDevDependency: string | null;
  lockfilePresent: boolean;
  repositoryUrl: string | null;
  lifecycleScripts: string[];
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function detectPackageManager(projectRoot: string): PackageRiskSignals['packageManager'] {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(projectRoot, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

export function collectPackageRisk(input: PackageRiskInput): EvidenceResult<PackageRiskSignals> {
  const projectRoot = input.projectRoot || process.cwd();
  const empty: PackageRiskSignals = {
    packageManager: 'unknown',
    declaredDependency: null,
    declaredDevDependency: null,
    lockfilePresent: false,
    repositoryUrl: null,
    lifecycleScripts: [],
  };

  try {
    const packageJson = readJson(join(projectRoot, 'package.json'));
    if (!packageJson) {
      return {
        ok: false,
        mode: 'library',
        subject: input.packageName,
        fetchedAt: nowIso(),
        signals: empty,
        warnings: [],
        errors: [`No package.json found at ${projectRoot}`],
      };
    }

    const dependencies = packageJson.dependencies as Record<string, string> | undefined;
    const devDependencies = packageJson.devDependencies as Record<string, string> | undefined;
    const scripts = packageJson.scripts as Record<string, string> | undefined;
    const repository = packageJson.repository as string | {url?: string} | undefined;
    const packageManager = detectPackageManager(projectRoot);
    const lockfilePresent = packageManager !== 'unknown';
    const lifecycleScripts = Object.keys(scripts || {}).filter((script) =>
      /^(preinstall|install|postinstall|prepare|prepack|postpack)$/.test(script),
    );

    return {
      ok: true,
      mode: 'library',
      subject: input.packageName,
      fetchedAt: nowIso(),
      signals: {
        packageManager,
        declaredDependency: dependencies?.[input.packageName] || null,
        declaredDevDependency: devDependencies?.[input.packageName] || null,
        lockfilePresent,
        repositoryUrl: typeof repository === 'string' ? repository : repository?.url || null,
        lifecycleScripts,
      },
      warnings: lifecycleScripts.length > 0 ? ['Lifecycle scripts require review before install.'] : [],
      errors: [],
    };
  } catch (error) {
    return errorResult('library', input.packageName, error, empty);
  }
}
