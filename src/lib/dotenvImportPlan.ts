import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';
import {loadEnvironmentManifest} from './environmentCommand.js';
import type {DotenvImportPlanItem} from './dotenvImportTypes.js';
import {findCheckoutRoot} from './workspace-context.js';

export interface DotenvImportPlanArtifact {
  schemaVersion: 1;
  kind: 'sift.vault.dotenv-import-plan';
  plan: {
    id: string;
    dialect: 'sift-dotenv-v1';
    ownerType: 'user' | 'workspace';
    ownerId: string;
    projectId: string | null;
    sourceNonce: string;
    sourceDigest: string;
    planDigest: string;
    items: DotenvImportPlanItem[];
    status: 'active';
    expiresAt: string;
  };
}

export async function readExplicitDotenvSource(sourcePath: string): Promise<{path: string; raw: Buffer}> {
  const requested = path.resolve(sourcePath);
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    const pathStat = await lstat(requested);
    if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('Dotenv import source must be an explicitly named stable regular non-symlink file.');
    }
    return {path: await realpath(requested), raw: await handle.readFile()};
  } finally {
    await handle.close();
  }
}

export async function assertDotenvSourceIsNotManaged(sourcePath: string, checkoutRoot: string): Promise<void> {
  let manifest;
  try {
    manifest = await loadEnvironmentManifest(checkoutRoot);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('.sift/environment.yaml is absent')) return;
    throw error;
  }
  const source = await realpath(path.resolve(sourcePath));
  const managedDestinations = new Set<string>();
  for (const member of manifest.members) {
    const destination = path.resolve(checkoutRoot, member.destination.path);
    try {
      managedDestinations.add(await realpath(destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      managedDestinations.add(destination);
    }
  }
  if (managedDestinations.has(source)) {
    throw new Error('Sift-managed environment files cannot be used as import sources. Import an explicitly maintained source file instead.');
  }
}

export async function resolveDotenvImportCheckoutRoot(
  sourcePath: string,
  explicitCheckoutRoot?: string,
): Promise<string> {
  const resolvedSource = await realpath(path.resolve(sourcePath));
  const sourceCheckout = findCheckoutRoot(path.dirname(resolvedSource));
  if (!explicitCheckoutRoot) {
    return realpath(sourceCheckout ?? findCheckoutRoot() ?? process.cwd());
  }

  const explicit = await realpath(path.resolve(explicitCheckoutRoot));
  const relativeSource = path.relative(explicit, resolvedSource);
  if (relativeSource === '' || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
    throw new Error('--checkout-root must contain the explicit dotenv source.');
  }
  if (sourceCheckout && await realpath(sourceCheckout) !== explicit) {
    throw new Error('--checkout-root must be the checkout that contains the explicit dotenv source.');
  }
  return explicit;
}

export async function writeDotenvImportPlanArtifact(
  filename: string,
  artifact: DotenvImportPlanArtifact,
): Promise<void> {
  const handle = await open(
    path.resolve(filename),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readDotenvImportPlanArtifact(filename: string): Promise<DotenvImportPlanArtifact> {
  const requested = path.resolve(filename);
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedStat = await handle.stat();
    const pathStat = await lstat(requested);
    if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('Dotenv import plan must be a stable regular non-symlink file.');
    }
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw) as DotenvImportPlanArtifact;
  if (parsed?.schemaVersion !== 1 || parsed.kind !== 'sift.vault.dotenv-import-plan'
    || parsed.plan?.dialect !== 'sift-dotenv-v1' || parsed.plan.status !== 'active'
    || !Array.isArray(parsed.plan.items)) {
    throw new Error('Dotenv import plan artifact is invalid or unsupported.');
  }
  return parsed;
}
