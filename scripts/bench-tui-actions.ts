#!/usr/bin/env tsx
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

type TargetName = 'sift' | 'opencode' | 'codex';

interface Action {
  name: string;
  send: string;
  waitFor: string;
  targetWaitFor?: Partial<Record<TargetName, string>>;
  cleanup?: string[];
  timeoutSec?: number;
}

interface Target {
  name: TargetName;
  command: string[];
  readyPattern: string;
  settleMs: number;
}

interface ActionResult {
  name: string;
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

interface RunResult {
  target: TargetName;
  command: string[];
  run: number;
  ok: boolean;
  totalMs: number;
  logPath: string;
  actions: ActionResult[];
  error?: string;
}

interface Options {
  root: string;
  runs: number;
  timeoutSec: number;
  outDir: string;
  targets: TargetName[];
  listOnly: boolean;
}

const DEFAULT_TARGETS: TargetName[] = ['sift', 'opencode', 'codex'];
const SHORT_INPUT = `bench-short-${Date.now().toString(36)}`;
const LONG_INPUT = `bench-long-${'x'.repeat(800)}-end`;

const ACTIONS: Action[] = [
  {
    name: 'short_input_repaint',
    send: SHORT_INPUT,
    waitFor: '.',
    cleanup: ['ctrl_u', 'escape'],
    timeoutSec: 3,
  },
  {
    name: 'slash_menu',
    send: '/',
    waitFor: looseAlternatives(['help', 'status', 'model', 'commands', 'session', 'theme', 'login', 'quit']),
    targetWaitFor: {
      codex: looseAlternatives(['help', 'init', 'model', 'approval', 'status', 'new', 'resume', 'command']),
      opencode: looseAlternatives(['help', 'model', 'theme', 'session', 'command', 'agent', 'editor']),
    },
    cleanup: ['escape', 'ctrl_u'],
    timeoutSec: 5,
  },
  {
    name: 'long_input_repaint',
    send: LONG_INPUT,
    waitFor: '.',
    cleanup: ['ctrl_u', 'escape'],
    timeoutSec: 5,
  },
];

main();

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const targets = buildTargets(options.root).filter((target) => options.targets.includes(target.name));

  if (options.listOnly) {
    for (const target of targets) {
      console.log(`${target.name}: ${target.command.join(' ')}`);
    }
    return;
  }

  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const startedAt = performance.now();
  const results: RunResult[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    for (const target of targets) {
      results.push(runTarget(target, run, options));
    }
  }

  const payload = {
    root: options.root,
    generatedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedAt),
    actions: ACTIONS.map((action) => action.name),
    results,
  };
  const jsonPath = join(options.outDir, 'results.json');
  const mdPath = join(options.outDir, 'results.md');
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(payload));

  console.log(renderMarkdown(payload));
  console.log(`\nArtifacts: ${options.outDir}`);
}

function printHelp(): void {
  console.log(`Usage: npm run bench:tui-actions --workspace @siftable/cli -- [options]

Options:
  --targets sift,opencode,codex  Comma-separated target list. Default: all.
  --runs 3                       Runs per target. Default: 3.
  --timeout 20                   Base expect timeout in seconds. Default: 20.
  --root /path/to/repo           Repo root to launch tools against. Default: monorepo root.
  --out artifacts/tui-bench/run  Artifact directory, relative to repo root unless absolute.
  --list                         Print resolved target commands without running.

The benchmark drives each TUI through expect and writes results.json, results.md,
and raw/*.log transcripts under the artifact directory.
`);
}

function parseArgs(args: string[]): Options {
  const root = resolve(valueAfter(args, '--root') || findRepoRoot(process.cwd()));
  const runs = positiveInt(valueAfter(args, '--runs'), 3);
  const timeoutSec = positiveInt(valueAfter(args, '--timeout'), 20);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outArg = valueAfter(args, '--out') || join('artifacts', 'tui-bench', timestamp);
  const outDir = resolve(root, outArg);
  const targetArg = valueAfter(args, '--targets');
  const targets = targetArg
    ? targetArg.split(',').map((part) => part.trim()).filter(Boolean) as TargetName[]
    : DEFAULT_TARGETS;
  const invalid = targets.filter((target) => !DEFAULT_TARGETS.includes(target));
  if (invalid.length) throw new Error(`unknown target(s): ${invalid.join(', ')}`);
  return {
    root,
    runs,
    timeoutSec,
    outDir,
    targets,
    listOnly: args.includes('--list'),
  };
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = join(current, 'package.json');
    if (existsSync(join(current, 'packages/exf-cli/bin/run.js')) && existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(start);
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`expected positive integer, got ${raw}`);
  return parsed;
}

function buildTargets(root: string): Target[] {
  return [
    {
      name: 'sift',
      command: ['node', join(root, 'packages/exf-cli/bin/run.js'), 'interactive'],
      readyPattern: looseAlternatives(['type a message', '/ commands', 'Siftable', 'siftable', 'keys']),
      settleMs: 500,
    },
    {
      name: 'opencode',
      command: ['opencode', root],
      readyPattern: looseAlternatives(['opencode', 'OpenCode', 'Type a message', 'session', 'messages', 'model']),
      settleMs: 1000,
    },
    {
      name: 'codex',
      command: ['codex', '--no-alt-screen', '-C', root],
      readyPattern: looseAlternatives(['execufunction', 'Codex', 'codex', 'Tip', 'help']),
      settleMs: 2500,
    },
  ];
}

function runTarget(target: Target, run: number, options: Options): RunResult {
  const safeCommand = target.command.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ');
  const logPath = join(options.outDir, 'raw', `${target.name}-${run}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  const tcl = buildExpectScript(target, ACTIONS, logPath, options.timeoutSec);
  const tempDir = mkdtempSync(join(tmpdir(), 'tui-bench-'));
  const scriptPath = join(tempDir, `${target.name}-${run}.expect`);
  writeFileSync(scriptPath, tcl);

  const startedAt = performance.now();
  const proc = spawnSync('expect', [scriptPath], {
    cwd: options.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color',
      COLUMNS: '120',
      LINES: '36',
    },
    timeout: (options.timeoutSec + ACTIONS.reduce((sum, action) => sum + (action.timeoutSec || 0), 0) + 8) * 1000,
  });

  const actions = parseMarkers(`${proc.stdout || ''}\n${proc.stderr || ''}`);
  const error = proc.error?.message || (proc.status && proc.status !== 0 ? `expect exited ${proc.status}` : undefined);
  const expectedMarkers = new Set(['launch_ready', ...ACTIONS.map((action) => action.name), 'clean_exit']);
  const seenMarkers = new Set(actions.map((action) => action.name));
  const missingMarkers = [...expectedMarkers].filter((name) => !seenMarkers.has(name));
  return {
    target: target.name,
    command: target.command,
    run,
    ok: !error && missingMarkers.length === 0 && actions.every((action) => action.ok),
    totalMs: Math.round(performance.now() - startedAt),
    logPath,
    actions,
    ...(error || missingMarkers.length
      ? { error: `${[error, missingMarkers.length ? `missing markers: ${missingMarkers.join(',')}` : ''].filter(Boolean).join('; ')}; command=${safeCommand}` }
      : {}),
  };
}

function buildExpectScript(target: Target, actions: Action[], logPath: string, timeoutSec: number): string {
  return `
set timeout ${timeoutSec}
log_user 1
log_file -noappend ${tclString(logPath)}
proc elapsed {start} { return [expr {[clock milliseconds] - $start}] }
proc mark {name ok start detail} {
  puts stderr "__TUI_BENCH__ name=$name ok=$ok elapsedMs=[elapsed $start] detail=$detail"
  flush stderr
}
proc cleanup {steps} {
  foreach step $steps {
    if {$step eq "ctrl_u"} { send "\\025" }
    if {$step eq "escape"} { send "\\033" }
    if {$step eq "ctrl_c"} { send "\\003" }
    after 80
  }
}
proc drain {} {
  global timeout
  set old_timeout $timeout
  set timeout 0
  expect {
    -re {(?s).+} { exp_continue }
    timeout {}
  }
  set timeout $old_timeout
}
set launch_start [clock milliseconds]
spawn -noecho ${target.command.map(tclString).join(' ')}
expect {
  -re ${tclString(dotAll(target.readyPattern))} { mark "launch_ready" 1 $launch_start "matched_ready" }
  -re {(?s).} { mark "launch_ready" 1 $launch_start "first_output" }
  timeout { mark "launch_ready" 0 $launch_start "timeout"; send "\\003"; exit 2 }
  eof { mark "launch_ready" 0 $launch_start "eof"; exit 3 }
}
after ${target.settleMs}
${actions.map((action) => renderAction(target.name, action)).join('\n')}
set exit_start [clock milliseconds]
send "\\025"
send "\\033"
after 120
send "\\003"
after 180
send "\\003"
expect {
  eof { mark "clean_exit" 1 $exit_start "eof" }
  timeout { catch {close}; mark "clean_exit" 0 $exit_start "timeout" }
}
`;
}

function renderAction(target: TargetName, action: Action): string {
  const cleanupSteps = action.cleanup ? action.cleanup.join(' ') : '';
  const waitFor = action.targetWaitFor?.[target] || action.waitFor;
  return `
set timeout ${action.timeoutSec || 5}
drain
set action_start [clock milliseconds]
send -- ${tclString(action.send)}
expect {
  -re ${tclString(dotAll(waitFor))} { mark ${tclString(action.name)} 1 $action_start "matched" }
  timeout { mark ${tclString(action.name)} 0 $action_start "timeout" }
  eof { mark ${tclString(action.name)} 0 $action_start "eof" }
}
cleanup ${tclString(cleanupSteps)}
`;
}

function dotAll(pattern: string): string {
  return pattern.startsWith('(?s)') ? pattern : `(?s)${pattern}`;
}

function looseAlternatives(words: string[]): string {
  return words.map(looseLiteralRegex).join('|');
}

function looseLiteralRegex(value: string): string {
  return value.split('').map((ch) => escapeRegex(ch)).join('.*');
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function tclString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')}"`;
}

function parseMarkers(stdout: string): ActionResult[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('__TUI_BENCH__ '))
    .map((line) => {
      const fields = Object.fromEntries(
        line
          .replace('__TUI_BENCH__ ', '')
          .split(/\s+/)
          .map((part) => {
            const index = part.indexOf('=');
            return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, ''];
          }),
      );
      return {
        name: fields.name || 'unknown',
        ok: fields.ok === '1',
        elapsedMs: Number(fields.elapsedMs || 0),
        ...(fields.detail && fields.detail !== 'matched' && fields.detail !== 'matched_ready' ? { error: fields.detail } : {}),
      };
    });
}

function renderMarkdown(payload: { root: string; generatedAt: string; results: RunResult[] }): string {
  const lines = [
    '# TUI Action Benchmark',
    '',
    `Root: \`${payload.root}\``,
    `Generated: ${payload.generatedAt}`,
    '',
    '| Target | Run | OK | Launch ms | Short repaint ms | Slash menu ms | Long repaint ms | Exit ms | Total ms |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const result of payload.results) {
    const byName = new Map(result.actions.map((action) => [action.name, action]));
    lines.push([
      result.target,
      String(result.run),
      result.ok ? 'yes' : 'no',
      cell(byName.get('launch_ready')),
      cell(byName.get('short_input_repaint')),
      cell(byName.get('slash_menu')),
      cell(byName.get('long_input_repaint')),
      cell(byName.get('clean_exit')),
      String(result.totalMs),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  const failures = payload.results.filter((result) => !result.ok);
  if (failures.length) {
    lines.push('', '## Failures', '');
    for (const failure of failures) {
      const failedActions = failure.actions.filter((action) => !action.ok);
      lines.push(
        `- ${failure.target} run ${failure.run}: ${failure.error || failedActions.map((action) => `${action.name}:${action.error || 'failed'}`).join(', ')}`,
      );
    }
  }

  lines.push('', 'Raw target transcripts are in `raw/*.log` beside `results.json`.');
  return `${lines.join('\n')}\n`;
}

function cell(action: ActionResult | undefined): string {
  if (!action) return '-';
  return action.ok ? String(action.elapsedMs) : `fail:${action.error || 'unknown'}`;
}
