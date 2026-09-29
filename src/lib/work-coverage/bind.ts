/**
 * Verification-step classification and test-file resolution for Jev work-coverage shadow mode.
 *
 * TypeScript port of the audited funnel (docs/research/jev-work-review-audit/scripts/funnel.py:
 * `classify`, `patterns`, `project_dir`, `resolve`) and the completeness reasons of `bind.py`.
 * Git is read through `execFile` (no shell): `git ls-tree -r --name-only <commit>` and
 * `git show <commit>:<path>`, both from the repository top level.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

// Workspace/Nx project name -> directory.
export const PROJECT_DIRS: Readonly<Record<string, string>> = {
  '@execufunction/exf-app': 'exf-app', 'exf-app': 'exf-app',
  '@execufunction/web': 'exf-app/web', 'exf-app/web': 'exf-app/web',
  '@execufunction/mobile': 'apps/mobile', 'apps/mobile': 'apps/mobile',
  '@execufunction/chrome-extension': 'apps/chrome-extension',
  '@execufunction/editorial-workbench': 'apps/editorial-workbench',
  '@siftable/cli': 'packages/exf-cli', 'packages/exf-cli': 'packages/exf-cli',
  '@siftable/mcp-server': 'packages/exf-mcp-server', 'packages/exf-mcp-server': 'packages/exf-mcp-server',
  '@execufunction/terminal-daemon': 'packages/exf-terminal-daemon',
  '@execufunction/shared': 'packages/shared', 'packages/shared': 'packages/shared',
  '@siftable/tabular-import': 'packages/tabular-import',
};

const hasProjectDir = (name: string): boolean => Object.prototype.hasOwnProperty.call(PROJECT_DIRS, name);

export const TEST_FILE = /\.(test|spec|vitest)\.(m?[jt]sx?|mjs|cjs)$|\.integration\.test\./;
const STATIC = new RegExp(
  '\\b(typecheck|tsc\\b|build\\b|lint\\b|diff --check|i18n|verify:|verify-|preflight|prettier|eslint|'
  + 'semgrep|JSON\\.parse|test -f|test -d|git diff|grep\\b|rg\\b|ls\\b|cat\\b|jq\\b|--dry-run|audit\\b)',
);
const TEST_RUNNER = /(^|[\s:])(test(:[\w-]+)?|jest|vitest|playwright|node --test|vp test)(\s|$)/;
const NON_JS = /(^|\s)(zig|cargo|go|pytest|python3? -m pytest|swift|xcodebuild|gradle|mvn)\s/;
const VALUE_FLAGS = new Set(['--workspace', '-w', '--prefix', '--testNamePattern', '-t', '--config', '-c', '--project',
  '-p', '--projects', '--reporter', '--shard', '--maxWorkers', '--testTimeout', '--grep', '-g', '--outputFile']);

export type Runner = 'vitest' | 'jest' | 'other';

export type StepClass =
  | {class: 'external_text'}
  | {class: 'unknown'; why?: string}
  | {class: 'static'}
  | {class: 'non_js_test'; why: string}
  | {class: 'whole_target'; projectDir: string | null; nameFilters?: string[]}
  | {class: 'patterned_test'; projectDir: string | null; patterns: string[]; nameFilters: string[]; runner: Runner};

export type PlanStep = {
  id?: string;
  key?: string;
  kind?: string;
  title?: string;
  spec?: Record<string, unknown> | null;
};

export function stepCommand(step: PlanStep): string {
  const command = step.spec?.command;
  if (typeof command === 'string' && command) return command;
  return step.title || '';
}

/** POSIX `shlex.split` (comments off). Throws on an unclosed quote or a trailing escape. */
export function shlexSplit(text: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let inToken = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= text.length) throw new Error('No escaped character');
      token += text[i + 1];
      inToken = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('No closing quotation');
      token += text.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '\\' && j + 1 < text.length && (text[j + 1] === '"' || text[j + 1] === '\\')) {
          token += text[j + 1];
          j += 2;
          continue;
        }
        if (d === '\\' && j + 1 >= text.length) throw new Error('No escaped character');
        token += d;
        j += 1;
      }
      if (!closed) throw new Error('No closing quotation');
      inToken = true;
      i = j + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (inToken) tokens.push(token);
      token = '';
      inToken = false;
      i += 1;
      continue;
    }
    token += c;
    inToken = true;
    i += 1;
  }
  if (inToken) tokens.push(token);
  return tokens;
}

function tokenize(cmd: string): string[] {
  try {
    return shlexSplit(cmd);
  } catch {
    return cmd.split(/\s+/).filter(Boolean);
  }
}

export function projectDir(tokens: string[], cwd: string | null): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '--workspace' || t === '-w' || t === '--prefix') && i + 1 < tokens.length) {
      return hasProjectDir(tokens[i + 1]) ? PROJECT_DIRS[tokens[i + 1]] : tokens[i + 1];
    }
    if (t.startsWith('--workspace=')) {
      const v = t.slice('--workspace='.length);
      return hasProjectDir(v) ? PROJECT_DIRS[v] : v;
    }
    const m = /^(@[\w-]+\/[\w-]+):/.exec(t);
    if (m) return hasProjectDir(m[1]) ? PROJECT_DIRS[m[1]] : null;
    if (hasProjectDir(t) && i > 0 && (tokens[i - 1] === 'test' || tokens[i - 1] === 'run')) return PROJECT_DIRS[t];
  }
  return cwd;
}

/** Positional test-file patterns/paths after the runner, and name filters (-t). */
export function patterns(tokens: string[]): {patterns: string[]; names: string[]} {
  const pats: string[] = [];
  const names: string[] = [];
  let started = false;
  let skip = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (skip) {
      skip = false;
      continue;
    }
    if (['-t', '--testNamePattern', '--grep', '-g'].includes(t) && i + 1 < tokens.length) {
      names.push(tokens[i + 1]);
      skip = true;
      continue;
    }
    const eq = /^(-t|--testNamePattern|--grep|-g)=(.*)$/.exec(t);
    if (eq) {
      names.push(eq[2]);
      continue;
    }
    if (VALUE_FLAGS.has(t)) {
      skip = true;
      continue;
    }
    if (/(^|:)(test(:\w+)?|jest|vitest)$/.test(t) || t === '--run') {
      started = true;
      continue;
    }
    if (['--', 'nx', 'npm', 'npx', 'exec', 'run', 'node_modules/.bin/vp'].includes(t) || t.endsWith('/jest')) continue;
    if (started && !t.startsWith('-') && !hasProjectDir(t) && !/^@[\w-]+\//.test(t) && !t.includes('=')) pats.push(t);
  }
  return {patterns: pats, names};
}

export function classify(step: PlanStep): StepClass {
  if (step.kind === 'external') return {class: 'external_text'};
  const cmd = stepCommand(step);
  if (cmd.trimStart().startsWith('[')) return {class: 'unknown', why: 'command list serialised as one step'};
  const tokens = tokenize(cmd);
  const joined = tokens.join(' ');
  const segments = joined.split(/\s(?:&&|\|\||;)\s/);
  const isTest = segments.some((s) => TEST_RUNNER.test(s)) || /\.test\.sh\b/.test(joined);
  if (!isTest) return STATIC.test(cmd) ? {class: 'static'} : {class: 'unknown'};
  if (NON_JS.test(` ${joined} `)) return {class: 'non_js_test', why: "runner outside this repository's JS toolchain"};
  const pdir = projectDir(tokens, null);
  const {patterns: pats, names} = patterns(tokens);
  if (cmd.includes('run-many') || cmd.includes('affected')) return {class: 'whole_target', projectDir: pdir};
  if (!pats.length) return {class: 'whole_target', projectDir: pdir, nameFilters: names};
  const runner: Runner = /vitest|vp test/.test(joined)
    ? 'vitest'
    : /(^|[\s:])(test|test:unit|jest)(\s|$)/.test(joined) ? 'jest' : 'other';
  return {class: 'patterned_test', projectDir: pdir, patterns: pats, nameFilters: names, runner};
}

export function resolve(pats: string[], pdir: string | null, files: readonly string[], runner: Runner = 'other'): string[] {
  const all = new Set(files);
  let tests = files.filter((f) => TEST_FILE.test(f));
  // Vitest projects in this repository include *.test.ts as well as *.vitest.ts, so a Vitest step keeps
  // every test file; Jest projects exclude *.vitest.* files.
  if (runner === 'jest') {
    tests = tests.filter((f) => !f.includes('.vitest.'));
  }
  const out = new Set<string>();
  for (const p of pats) {
    if (p.includes('/') || TEST_FILE.test(p)) {
      const exact = [p, pdir ? `${pdir}/${p}` : p].filter((cand) => all.has(cand));
      for (const cand of exact) out.add(cand);
      if (exact.length) continue;
      // Runners treat positional paths as filters: a directory or file-name prefix selects the test files under it.
      for (const f of tests) {
        const rel = pdir && f.startsWith(`${pdir}/`) ? f.slice(pdir.length + 1) : f;
        if (f.startsWith(p) || rel.startsWith(p)) out.add(f);
      }
      continue;
    }
    let rx: RegExp;
    try {
      rx = new RegExp(p);
    } catch {
      continue;
    }
    for (const f of tests) if ((!pdir || f.startsWith(`${pdir}/`)) && rx.test(f)) out.add(f);
  }
  return [...out].sort();
}

export type StepBinding = {stepId?: string; key?: string; command: string; resolved?: string[]} & StepClass;

export type PlanBinding = {
  steps: StepBinding[];
  testFiles: string[];
  candidatesComplete: boolean;
  incompleteReasons: string[];
};

/** bind.py: test files a plan's steps name at `files` (one commit), and why the list may be incomplete. */
export function bindPlan(steps: readonly PlanStep[], files: readonly string[]): PlanBinding {
  const testFiles = new Set<string>();
  const reasons: string[] = [];
  const out: StepBinding[] = [];
  for (const s of steps) {
    const c = classify(s);
    const cmd = stepCommand(s);
    const row: StepBinding = {stepId: s.id, key: s.key, command: cmd, ...c};
    if (c.class === 'patterned_test') {
      const got = resolve(c.patterns, c.projectDir, files, c.runner);
      row.resolved = got;
      for (const f of got) testFiles.add(f);
      if (!got.length) reasons.push(`pattern resolved to no file: ${cmd.slice(0, 120)}`);
    } else if (c.class === 'whole_target' || c.class === 'unknown' || c.class === 'non_js_test') {
      reasons.push(`${c.class}: ${cmd.slice(0, 120)}`);
    }
    out.push(row);
  }
  return {steps: out, testFiles: [...testFiles].sort(), candidatesComplete: reasons.length === 0, incompleteReasons: reasons};
}

// ---------- git ----------

export interface GitReader {
  /** Full 40-hex SHA of `ref` as a commit, or null when it does not resolve. */
  resolveCommit(ref: string): Promise<string | null>;
  /** Every path in the tree at `commit`, relative to the repository root. */
  listFiles(commit: string): Promise<string[]>;
  /** File contents at `commit`, or '' when the path does not exist there. */
  show(commit: string, path: string): Promise<string>;
}

const GIT_BUFFER = 256 * 1024 * 1024;

export function createGitReader(cwd: string = process.cwd()): GitReader {
  let top: Promise<string> | undefined;
  const git = async (args: string[], dir: string): Promise<string> => {
    const {stdout} = await execFileAsync('git', args, {cwd: dir, maxBuffer: GIT_BUFFER, encoding: 'utf8'});
    return stdout;
  };
  const root = (): Promise<string> => {
    top ??= git(['rev-parse', '--show-toplevel'], cwd).then((out) => out.trim());
    return top;
  };
  return {
    async resolveCommit(ref) {
      try {
        const sha = (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).trim();
        return sha || null;
      } catch {
        return null;
      }
    },
    async listFiles(commit) {
      const out = await git(['ls-tree', '-r', '--name-only', commit], await root());
      return out.split('\n').filter(Boolean);
    },
    async show(commit, path) {
      try {
        return await git(['show', `${commit}:${path}`], await root());
      } catch {
        return '';
      }
    },
  };
}
