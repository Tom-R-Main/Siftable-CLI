/**
 * The attempt's checkout (first-run U5b-2c), plan side. A plan names a public
 * GitHub repository, a base commit and the directories the writer may change.
 * Everything here is checked before any network call or container: a URL that
 * could reach another host, carry a credential or follow a redirect elsewhere
 * is refused, and so is a write scope that could name the repository root, the
 * git directory, a parent, or overlap another scope. The same literal scope
 * string later becomes the volume subpath and the git pathspec, so nothing
 * here normalizes it.
 */

/** Public GitHub over https only, in v1. Owner and repository names as GitHub allows them. */
const REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?(?:\.git)?$/;
export const MAX_WRITE_SCOPES = 64;
const MAX_SCOPE_BYTES = 512;

export interface CheckoutPlan {
  repositoryUrl: string;
  baseSha: string;
  writeScope: string[];
}

/** Why the URL cannot be fetched, or undefined when it can. */
export function repositoryUrlProblem(url: unknown): string | undefined {
  if (typeof url !== 'string' || !REPOSITORY_URL.test(url)) return 'repositoryUrl must be https://github.com/<owner>/<repository>';
  const name = url.slice('https://github.com/'.length).split('/')[1].replace(/\.git$/, '');
  if (name === '.' || name === '..' || name === '') return 'repositoryUrl must name a repository';
  return undefined;
}

/** Why one scope cannot be mounted writable, or undefined when it can. */
export function writeScopeProblem(scope: unknown): string | undefined {
  if (typeof scope !== 'string' || scope.length === 0) return 'A write scope must be a nonempty path';
  if (Buffer.byteLength(scope) > MAX_SCOPE_BYTES) return `A write scope is at most ${MAX_SCOPE_BYTES} bytes`;
  // Control characters, backslash and NUL could mean different paths to Docker, git and the kernel.
  // Docker parses --mount as CSV, so a comma or quote would change the mount.
  if ([...scope].some((char) => char.charCodeAt(0) < 0x20 || char === '\u007f' || char === '\\' || char === ',' || char === '"')) {
    return 'A write scope cannot contain control characters, a backslash, a comma or a quote';
  }
  if (scope.startsWith('/') || scope.endsWith('/')) return 'A write scope is relative, with no leading or trailing slash';
  for (const segment of scope.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'A write scope cannot have an empty, "." or ".." segment';
    if (segment.toLowerCase() === '.git') return 'A write scope cannot include .git';
  }
  return undefined;
}

/** Why the plan's checkout cannot start, or undefined when it can. */
export function checkoutPlanProblem(plan: Partial<CheckoutPlan>): string | undefined {
  const urlProblem = repositoryUrlProblem(plan.repositoryUrl);
  if (urlProblem) return urlProblem;
  if (typeof plan.baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(plan.baseSha)) return 'baseSha must be 40 lowercase hex characters';
  const scopes = plan.writeScope;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_WRITE_SCOPES) return `writeScope must hold 1 to ${MAX_WRITE_SCOPES} directories`;
  for (const scope of scopes) {
    const problem = writeScopeProblem(scope);
    if (problem) return problem;
  }
  // No scope may equal or contain another: each becomes its own mount, and nested mounts would make the order matter.
  for (const a of scopes as string[]) {
    for (const b of scopes as string[]) {
      if (a !== b && b.startsWith(`${a}/`)) return `Write scopes cannot nest: ${a} contains ${b}`;
    }
  }
  if (new Set(scopes).size !== scopes.length) return 'Write scopes must be distinct';
  return undefined;
}
