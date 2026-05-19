import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';

export interface SkillpackSummary {
  id: string;
  name: string;
  description: string;
  sourceDir: string;
}

export function findSkillpacksRoot(startDir = process.cwd()): string | undefined {
  const candidates = [];
  let current = resolve(startDir);

  while (true) {
    candidates.push(join(current, 'skillpacks'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const moduleDir = __dirname;
  current = moduleDir;
  while (true) {
    candidates.push(join(current, 'skillpacks'));
    candidates.push(join(current, '..', 'skillpacks'));
    candidates.push(join(current, '..', '..', 'skillpacks'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
}

function readSkillMetadata(skillDir: string): {name: string; description: string} {
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath)) {
    return {name: basename(skillDir), description: ''};
  }

  const raw = readFileSync(skillPath, 'utf8');
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1] || '';
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || basename(skillDir);
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  return {name, description};
}

export function listSkillpacks(root = findSkillpacksRoot()): SkillpackSummary[] {
  if (!root) return [];

  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .filter((entryPath) => existsSync(join(entryPath, 'SKILL.md')))
    .map((entryPath) => {
      const metadata = readSkillMetadata(entryPath);
      return {
        id: basename(entryPath),
        name: metadata.name,
        description: metadata.description,
        sourceDir: entryPath,
      };
    });
}

export function findSkillpack(id: string, root = findSkillpacksRoot()): SkillpackSummary | undefined {
  return listSkillpacks(root).find((skillpack) => skillpack.id === id || skillpack.name === id);
}

export function copyDirectory(sourceDir: string, targetDir: string, options?: {force?: boolean}): void {
  if (existsSync(targetDir)) {
    if (!options?.force) {
      throw new Error(`Target already exists: ${targetDir}`);
    }
    rmSync(targetDir, {recursive: true, force: true});
  }

  mkdirSync(targetDir, {recursive: true});
  for (const entry of readdirSync(sourceDir, {withFileTypes: true})) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, {force: true});
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  }
}
