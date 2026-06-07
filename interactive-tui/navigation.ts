import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "deno.json",
  "bun.lockb",
  "AGENTS.md",
  "README.md",
  "README",
];

const SKIP_DISCOVERY_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "zig-cache",
  "zig-out",
]);

export interface NavigationState {
  implementationDir: string;
  sessionCwd: string;
  workspaceRoot: string;
}

export interface SessionCwdChange {
  cwd: string;
  previousCwd: string;
  workspaceRoot: string;
  previousWorkspaceRoot: string;
  workspaceRootChanged: boolean;
}

export interface LocalWorkspaceCandidate {
  root: string;
  name: string;
  depth: number;
  score: number;
  signals: string[];
}

export interface LocalWorkspaceDiscoveryResult {
  roots: string[];
  query?: string;
  truncated: boolean;
  matches: LocalWorkspaceCandidate[];
}

export function expandHomePath(pathInput: string): string {
  const input = pathInput || ".";
  if (!input.startsWith("~")) return input;
  const home = process.env.HOME || "";
  return input.replace(/^~/, home);
}

export function getSessionCwd(): string {
  return process.env.SIFT_USER_CWD || process.cwd();
}

export function resolveSessionPath(pathInput: string, base = getSessionCwd()): string {
  const expanded = expandHomePath(pathInput || ".");
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(base, expanded);
}

export function resolveWorkspaceRootFrom(pathInput: string): string {
  const start = resolveSessionPath(pathInput || ".");
  let current = start;
  try {
    if (!statSync(start).isDirectory()) current = dirname(start);
  } catch {
    current = dirname(start);
  }

  for (let dir = current; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
  }

  for (let dir = current; ; dir = dirname(dir)) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
  }

  return current;
}

export function getWorkspaceRoot(): string {
  return process.env.SIFT_WORKSPACE_ROOT || resolveWorkspaceRootFrom(getSessionCwd());
}

export function getNavigationState(): NavigationState {
  return {
    implementationDir: process.cwd(),
    sessionCwd: getSessionCwd(),
    workspaceRoot: getWorkspaceRoot(),
  };
}

export function setSessionCwd(pathInput: string): SessionCwdChange {
  const previousCwd = getSessionCwd();
  const previousWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT || "";
  const cwd = resolveSessionPath(pathInput || ".", previousCwd);
  const stat = statSync(cwd);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${cwd}`);

  const workspaceRoot = resolveWorkspaceRootFrom(cwd);
  process.env.SIFT_USER_CWD = cwd;
  process.env.SIFT_WORKSPACE_ROOT = workspaceRoot;

  return {
    cwd,
    previousCwd,
    workspaceRoot,
    previousWorkspaceRoot,
    workspaceRootChanged: previousWorkspaceRoot !== workspaceRoot,
  };
}

/**
 * Restore the session cwd/workspace-root env to a previously-captured state.
 *
 * Unlike calling {@link setSessionCwd} with the old cwd, this sets the workspace
 * root back to its *exact* prior value rather than re-deriving it from the cwd.
 * That matters when the prior root was set explicitly (e.g. via
 * `SIFT_WORKSPACE_ROOT`) rather than discovered: re-derivation could land on a
 * different directory. Pairs with the `previousCwd`/`previousWorkspaceRoot`
 * fields {@link setSessionCwd} returns so an enter→leave round-trips exactly,
 * including through nested switches. An empty captured value means the env var
 * was unset at capture time, so we unset it again (back to the derived default).
 */
export function restoreSessionCwd(previous: {
  previousCwd: string;
  previousWorkspaceRoot: string;
}): void {
  if (previous.previousCwd) process.env.SIFT_USER_CWD = previous.previousCwd;
  else delete process.env.SIFT_USER_CWD;
  if (previous.previousWorkspaceRoot) process.env.SIFT_WORKSPACE_ROOT = previous.previousWorkspaceRoot;
  else delete process.env.SIFT_WORKSPACE_ROOT;
}

function defaultDiscoveryRoots(): string[] {
  const roots = [
    process.env.HOME ? join(process.env.HOME, "projects") : "",
    dirname(getSessionCwd()),
    dirname(getWorkspaceRoot()),
  ].filter(Boolean);
  return [...new Set(roots.map((root) => resolveSessionPath(root)))].filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function matchScore(candidate: LocalWorkspaceCandidate, query?: string): number {
  const q = (query || "").trim().toLowerCase();
  let score = candidate.signals.includes(".git") ? 50 : 20;
  score += Math.max(0, 10 - candidate.depth);
  if (!q) return score;
  const name = candidate.name.toLowerCase();
  const root = candidate.root.toLowerCase();
  if (name === q) score += 100;
  else if (name.includes(q)) score += 60;
  else if (root.includes(q)) score += 30;
  else score -= 100;
  return score;
}

async function candidateSignals(root: string): Promise<string[]> {
  const signals: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has(".git")) signals.push(".git");
  for (const marker of PROJECT_MARKERS) {
    if (names.has(marker)) signals.push(marker);
  }
  return signals;
}

export async function discoverLocalWorkspaces(input: {
  roots?: string[];
  query?: string;
  maxDepth?: number;
  limit?: number;
} = {}): Promise<LocalWorkspaceDiscoveryResult> {
  const maxDepth = Math.max(0, Math.min(input.maxDepth ?? 2, 4));
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const roots = (input.roots?.length ? input.roots : defaultDiscoveryRoots())
    .map((root) => resolveSessionPath(root))
    .filter((root, index, arr) => arr.indexOf(root) === index);
  const queue = roots.map((root) => ({ root, depth: 0 }));
  const seen = new Set<string>();
  const matches: LocalWorkspaceCandidate[] = [];
  let visited = 0;
  let truncated = false;

  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next.root)) continue;
    seen.add(next.root);
    visited += 1;
    if (visited > 2000) {
      truncated = true;
      break;
    }

    let entries;
    try {
      entries = await readdir(next.root, { withFileTypes: true });
    } catch {
      continue;
    }

    const signals = await candidateSignals(next.root).catch(() => []);
    if (signals.length) {
      const candidate: LocalWorkspaceCandidate = {
        root: next.root,
        name: basename(next.root),
        depth: next.depth,
        score: 0,
        signals,
      };
      candidate.score = matchScore(candidate, input.query);
      if (candidate.score > 0) matches.push(candidate);
    }

    if (next.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DISCOVERY_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".config") continue;
      queue.push({ root: join(next.root, entry.name), depth: next.depth + 1 });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.root.localeCompare(b.root));
  return {
    roots,
    query: input.query,
    truncated,
    matches: matches.slice(0, limit),
  };
}
