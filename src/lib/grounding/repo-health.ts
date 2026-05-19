import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {errorResult, EvidenceResult, nowIso} from './types.js';

export interface RepoHealthInput {
  repoUrl?: string;
  localPath: string;
}

export interface RepoHealthSignals extends Record<string, unknown> {
  manifests: string[];
  hasLicense: boolean;
  hasSecurityPolicy: boolean;
  hasCi: boolean;
  lifecycleScripts: string[];
  fileCount: number;
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'];

function countFiles(path: string, limit = 20000): number {
  let count = 0;
  const stack = [path];
  while (stack.length > 0 && count < limit) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) count += 1;
    }
  }
  return count;
}

export function collectRepoHealth(input: RepoHealthInput): EvidenceResult<RepoHealthSignals> {
  const empty: RepoHealthSignals = {
    manifests: [],
    hasLicense: false,
    hasSecurityPolicy: false,
    hasCi: false,
    lifecycleScripts: [],
    fileCount: 0,
  };

  try {
    if (!existsSync(input.localPath) || !statSync(input.localPath).isDirectory()) {
      return {
        ok: false,
        mode: 'repo',
        subject: input.repoUrl || input.localPath,
        fetchedAt: nowIso(),
        signals: empty,
        warnings: [],
        errors: [`Repository path not found: ${input.localPath}`],
      };
    }

    const manifests = MANIFESTS.filter((manifest) => existsSync(join(input.localPath, manifest)));
    const hasLicense = readdirSync(input.localPath).some((entry) => /^licen[sc]e/i.test(entry));
    const hasSecurityPolicy = existsSync(join(input.localPath, 'SECURITY.md')) ||
      existsSync(join(input.localPath, '.github', 'SECURITY.md'));
    const hasCi = existsSync(join(input.localPath, '.github', 'workflows'));
    const packageJsonPath = join(input.localPath, 'package.json');
    let lifecycleScripts: string[] = [];
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {scripts?: Record<string, string>};
      lifecycleScripts = Object.keys(packageJson.scripts || {}).filter((script) =>
        /^(preinstall|install|postinstall|prepare|prepack|postpack)$/.test(script),
      );
    }

    return {
      ok: true,
      mode: 'repo',
      subject: input.repoUrl || input.localPath,
      fetchedAt: nowIso(),
      signals: {
        manifests,
        hasLicense,
        hasSecurityPolicy,
        hasCi,
        lifecycleScripts,
        fileCount: countFiles(input.localPath),
      },
      warnings: lifecycleScripts.length > 0 ? ['Repository has lifecycle scripts; do not execute before review.'] : [],
      errors: [],
    };
  } catch (error) {
    return errorResult('repo', input.repoUrl || input.localPath, error, empty);
  }
}
