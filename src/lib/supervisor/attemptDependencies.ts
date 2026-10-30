/**
 * Dependency admission for an attempt (first-run, dependency install contract
 * rev 3). Before any network, the supervisor reads the checkout's
 * package.json and package-lock.json as data and decides whether `npm ci
 * --ignore-scripts` behind the registry-only proxy can install them. v1
 * admits npm lockfiles (version 2 or 3) whose every package comes from the
 * public npm registry with a sha512 integrity. Git, URL, file and link
 * sources, workspaces, linked entries and bundled dependencies are refused;
 * npm is never run here.
 */

export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const REGISTRY = 'https://registry.npmjs.org/';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** A semver range or a dist-tag: no scheme, path, fragment or backslash can appear in one. */
const RANGE = /^[A-Za-z0-9 .*^~<>=|_+-]*$/;

export class DependencyRefused extends Error {
  readonly code = 'unsupported_dependency_source';
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: string, file: string): Json {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new DependencyRefused(`${file} is larger than ${MAX_MANIFEST_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DependencyRefused(`${file} is not JSON`);
  }
  if (!isObject(value)) throw new DependencyRefused(`${file} is not a JSON object`);
  return value;
}

/** A range or dist-tag from the registry, or `npm:<name>[@<range>]`; never a URL, git, file, link or GitHub shorthand. */
export function specProblem(name: string, spec: unknown): string | undefined {
  if (typeof spec !== 'string') return `${name}: the version spec is not a string`;
  if (spec.startsWith('npm:')) {
    const alias = spec.slice(4);
    const at = alias.lastIndexOf('@');
    const [target, range] = at > 0 ? [alias.slice(0, at), alias.slice(at + 1)] : [alias, ''];
    if (!PACKAGE_NAME.test(target) || !RANGE.test(range)) return `${name}: ${spec} is not an alias to a registry package`;
    return undefined;
  }
  if (!RANGE.test(spec)) return `${name}: ${spec} is not a registry version range`;
  return undefined;
}

function specsProblem(owner: string, manifest: Json): string | undefined {
  if (manifest.workspaces !== undefined) return `${owner} declares workspaces`;
  for (const field of DEPENDENCY_FIELDS) {
    const specs = manifest[field];
    if (specs === undefined) continue;
    if (!isObject(specs)) return `${owner} ${field} is not an object`;
    for (const [name, spec] of Object.entries(specs)) {
      const problem = specProblem(name, spec);
      if (problem) return `${owner} ${field}: ${problem}`;
    }
  }
  return undefined;
}

/** Why an entry is not a registry tarball with a sha512 integrity, or undefined when it is. */
function sourceProblem(location: string, entry: Json): string | undefined {
  const resolved = entry.resolved;
  if (typeof resolved !== 'string' || !resolved.startsWith(REGISTRY) || /[?#\\]|\/\.\.?\//.test(resolved.slice(REGISTRY.length))) {
    return `package-lock.json entry ${location} does not come from ${REGISTRY}`;
  }
  if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
    return `package-lock.json entry ${location} has no sha512 integrity`;
  }
  return undefined;
}


/**
 * Admits the checkout's manifests, or throws DependencyRefused naming the
 * first reason. Returns how many packages the lockfile installs.
 */
export function admitDependencies(packageJsonText: string, lockText: string): {packages: number} {
  const manifest = parse(packageJsonText, 'package.json');
  const lock = parse(lockText, 'package-lock.json');
  const fail = (problem: string | undefined) => { if (problem) throw new DependencyRefused(problem); };
  fail(specsProblem('package.json', manifest));
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new DependencyRefused('package-lock.json must be lockfileVersion 2 or 3');
  if (!isObject(lock.packages)) throw new DependencyRefused('package-lock.json has no packages');
  let packages = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!isObject(entry)) throw new DependencyRefused(`package-lock.json entry ${location || '(root)'} is not an object`);
    if (entry.link === true) throw new DependencyRefused(`package-lock.json entry ${location} is a link`);
    // The root entry describes the project itself: no tarball, but its specs are checked like package.json's.
    if (location === '') {
      fail(specsProblem('package-lock.json root entry', entry));
      continue;
    }
    if (!location.startsWith('node_modules/') || location.split('/').some((part) => part === '..' || part === '.')) {
      throw new DependencyRefused(`package-lock.json entry ${location} is outside node_modules`);
    }
    // A bundled entry has no tarball or integrity of its own. Whether a checked package really bundles it is npm's
    // own graph logic, which v1 does not reproduce: the flag alone proves nothing (npm fetches an unbundled entry on
    // its own), so bundled dependencies are refused rather than exempted on an unproven claim.
    if (entry.inBundle === true) throw new DependencyRefused(`package-lock.json entry ${location} is a bundled dependency, which v1 does not install`);
    fail(sourceProblem(location, entry));
    packages += 1;
  }
  return {packages};
}
