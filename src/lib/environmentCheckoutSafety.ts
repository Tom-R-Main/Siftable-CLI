import {lstat, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {validateMaterializationPath} from './localMaterializer.js';

export type EnvironmentCheckoutSafetyCode =
  | 'absolute_path'
  | 'case_collision'
  | 'checkout_escape'
  | 'git_destination'
  | 'invalid_relative_path'
  | 'non_owned_ancestor'
  | 'non_normalized_unicode'
  | 'symlinked_ancestor'
  | 'writable_ancestor';

export class EnvironmentCheckoutSafetyError extends Error {
  override name = 'EnvironmentCheckoutSafetyError';
  constructor(public readonly code: EnvironmentCheckoutSafetyCode, message: string) {
    super(message);
  }
}

function syntaxError(relativeDestination: string): EnvironmentCheckoutSafetyError | null {
  if (path.isAbsolute(relativeDestination) || /^[A-Za-z]:[\\/]/.test(relativeDestination)) {
    return new EnvironmentCheckoutSafetyError('absolute_path', 'Environment destination must be relative');
  }
  if (relativeDestination !== relativeDestination.normalize('NFC')) {
    return new EnvironmentCheckoutSafetyError('non_normalized_unicode', 'Environment destination must use Unicode NFC');
  }
  if (!relativeDestination || relativeDestination.includes('\\') || relativeDestination.includes('\0')
    || relativeDestination.endsWith('/') || relativeDestination.includes('//') || /[*?[\]{}]/.test(relativeDestination)) {
    return new EnvironmentCheckoutSafetyError('invalid_relative_path', 'Environment destination is not an exact portable relative path');
  }
  const segments = relativeDestination.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return new EnvironmentCheckoutSafetyError('checkout_escape', 'Environment destination may not traverse the checkout');
  }
  if (segments.some(segment => segment.toLocaleLowerCase('en-US') === '.git')) {
    return new EnvironmentCheckoutSafetyError('git_destination', 'Environment destination may not enter Git metadata');
  }
  if (path.posix.normalize(relativeDestination) !== relativeDestination) {
    return new EnvironmentCheckoutSafetyError('invalid_relative_path', 'Environment destination must already be normalized');
  }
  return null;
}

async function inspectAncestors(checkoutRoot: string, relativeDestination: string): Promise<void> {
  const owner = process.getuid?.();
  const segments = relativeDestination.split('/');
  let current = checkoutRoot;
  const ancestors = [checkoutRoot];
  for (const [index, segment] of segments.entries()) {
    const entries = await readdir(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const normalizedIdentity = segment.normalize('NFC');
    const fold = normalizedIdentity.toLocaleLowerCase('en-US');
    const collision = entries.find(entry => {
      const entryIdentity = entry.normalize('NFC');
      return entryIdentity !== normalizedIdentity && entryIdentity.toLocaleLowerCase('en-US') === fold;
    });
    if (collision) {
      throw new EnvironmentCheckoutSafetyError('case_collision', `Destination segment collides with existing ${JSON.stringify(collision)}`);
    }
    if (index < segments.length - 1) {
      current = path.join(current, segment);
      ancestors.push(current);
    }
  }

  for (const ancestor of ancestors) {
    let info;
    try {
      info = await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new EnvironmentCheckoutSafetyError('symlinked_ancestor', `Destination ancestor is symlinked: ${ancestor}`);
    }
    if (!info.isDirectory()) {
      throw new EnvironmentCheckoutSafetyError('checkout_escape', `Destination ancestor is not a directory: ${ancestor}`);
    }
    if (owner !== undefined && info.uid !== owner) {
      throw new EnvironmentCheckoutSafetyError('non_owned_ancestor', `Destination ancestor is not owned by the current user: ${ancestor}`);
    }
    if ((info.mode & 0o022) !== 0) {
      throw new EnvironmentCheckoutSafetyError('writable_ancestor', `Destination ancestor is group/world writable: ${ancestor}`);
    }
  }
}

export async function assertDestinationSafeBeforeApproval(
  checkoutRoot: string,
  relativeDestination: string,
): Promise<{checkoutRoot: string; destinationPath: string; relativeDestination: string}> {
  const syntax = syntaxError(relativeDestination);
  if (syntax) throw syntax;
  if (!path.isAbsolute(checkoutRoot) || path.normalize(checkoutRoot) !== checkoutRoot) {
    throw new EnvironmentCheckoutSafetyError('checkout_escape', 'Checkout root must be an absolute normalized path');
  }
  const destinationPath = path.resolve(checkoutRoot, relativeDestination);
  const relative = path.relative(checkoutRoot, destinationPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EnvironmentCheckoutSafetyError('checkout_escape', 'Environment destination escapes the checkout');
  }
  try {
    await validateMaterializationPath({destinationPath, workspaceRoot: checkoutRoot});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/symlink/i.test(message)) throw new EnvironmentCheckoutSafetyError('symlinked_ancestor', message);
    if (/ownership/i.test(message)) throw new EnvironmentCheckoutSafetyError('non_owned_ancestor', message);
    throw new EnvironmentCheckoutSafetyError('checkout_escape', message);
  }
  await inspectAncestors(checkoutRoot, relativeDestination);
  try {
    const info = await stat(destinationPath);
    if ((info.mode & 0o022) !== 0) {
      throw new EnvironmentCheckoutSafetyError('writable_ancestor', 'Existing destination is group/world writable');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {checkoutRoot, destinationPath, relativeDestination};
}
