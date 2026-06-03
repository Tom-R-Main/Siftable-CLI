import {execFileSync} from 'node:child_process';

export interface DailyReviewContextOptions {
  limit?: number;
  calendarDays?: number;
  skipGit?: boolean;
  cwd?: string;
  now?: Date;
}

export interface CapturedSource<T = unknown> {
  label: string;
  ok: true;
  data?: T;
}

export interface UnavailableSource {
  label: string;
  ok: false;
  error: string;
  statusCode: number;
}

export type CapturedCheck<T = unknown> = CapturedSource<T> | UnavailableSource;

export interface LocalGitSummary {
  skipped?: boolean;
  repositoryRoot?: string | null;
  branch?: string | null;
  head?: string | null;
  status?: string | null;
  stashes?: string | null;
  recentCommits?: string | null;
  filesChangedThisWeek?: string | null;
}

export interface GitRecapSummary {
  since: string;
  commits: string | null;
  representativeFiles: string[];
}

export interface DailyReviewContext {
  collectedAt: string;
  coverage: {
    unavailable: Array<{source: string; error: string; statusCode: number}>;
    checked: string[];
    git: 'skipped' | 'attempted';
  };
  sources: Record<string, unknown>;
  localGit: LocalGitSummary;
}

type ApiResponse<T = unknown> = {data?: T; error?: string; statusCode: number};

export interface DailyReviewClient {
  listProjects(options?: Record<string, unknown>): Promise<ApiResponse>;
  listAgents(options?: Record<string, unknown>): Promise<ApiResponse>;
  listWorkItems(options?: Record<string, unknown>): Promise<ApiResponse>;
  listTasks(options?: Record<string, unknown>): Promise<ApiResponse>;
  listCodeRepositories(options?: Record<string, unknown>): Promise<ApiResponse>;
  listCodeMemories(options?: Record<string, unknown>): Promise<ApiResponse>;
  listCalendarEvents(options?: Record<string, unknown>): Promise<ApiResponse>;
  listVaultEntries(options?: Record<string, unknown>): Promise<ApiResponse>;
}

function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export async function capture<T>(
  label: string,
  operation: () => Promise<ApiResponse<T>>,
): Promise<CapturedCheck<T>> {
  const response = await operation();
  if (response.error) {
    return {
      label,
      ok: false,
      error: response.error,
      statusCode: response.statusCode,
    };
  }
  return {label, ok: true, data: response.data};
}

export function collectLocalGitSummary(options: Pick<DailyReviewContextOptions, 'skipGit' | 'cwd'> = {}): LocalGitSummary {
  if (options.skipGit) {
    return {skipped: true};
  }

  return {
    repositoryRoot: git(['rev-parse', '--show-toplevel'], options.cwd),
    branch: git(['branch', '--show-current'], options.cwd),
    head: git(['rev-parse', '--short', 'HEAD'], options.cwd),
    status: git(['status', '--short'], options.cwd),
    stashes: git(['stash', 'list'], options.cwd),
    recentCommits: git(['log', '--since=yesterday 00:00', '--pretty=format:%h%x09%ad%x09%s', '--date=iso', '--max-count=20'], options.cwd),
    filesChangedThisWeek: git(['log', '--since=monday 00:00', '--name-only', '--pretty=format:', '--max-count=100'], options.cwd),
  };
}

export function collectGitRecapSummary(options: {cwd?: string; since?: string; maxCommits?: number; maxFiles?: number} = {}): GitRecapSummary {
  const since = options.since || '90 days ago';
  const commits = git([
    'log',
    `--since=${since}`,
    '--pretty=format:%h%x09%ad%x09%s',
    '--date=short',
    `--max-count=${options.maxCommits ?? 80}`,
  ], options.cwd);
  const files = git([
    'log',
    `--since=${since}`,
    '--name-only',
    '--pretty=format:',
    `--max-count=${options.maxCommits ?? 200}`,
  ], options.cwd);
  const representativeFiles = [...new Set((files ?? '').split('\n').filter(Boolean))]
    .slice(0, options.maxFiles ?? 12);

  return {
    since,
    commits,
    representativeFiles,
  };
}

export async function collectDailyReviewContext(
  client: DailyReviewClient,
  options: DailyReviewContextOptions = {},
): Promise<DailyReviewContext> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 20;
  const calendarDays = options.calendarDays ?? 7;
  const calendarEnd = new Date(now);
  calendarEnd.setDate(calendarEnd.getDate() + calendarDays);

  const checks = await Promise.all([
    capture('projects', () => client.listProjects({includeArchived: false})),
    capture('agents', () => client.listAgents({includeDisabled: true})),
    capture('workItems', () => client.listWorkItems({limit})),
    capture('tasksInProgress', () => client.listTasks({status: 'in_progress', limit})),
    capture('tasksOpenPhase', () => client.listTasks({phase: 'open', limit})),
    capture('codeRepositories', () => client.listCodeRepositories()),
    capture('codeMemories', () => client.listCodeMemories({limit})),
    capture('calendar', () => client.listCalendarEvents({
      startDate: now.toISOString(),
      endDate: calendarEnd.toISOString(),
      limit,
    })),
    capture('vaultMetadata', () => client.listVaultEntries({limit})),
  ]);

  const sources = Object.fromEntries(checks.map((check) => {
    if (check.ok) {
      return [check.label, check.data];
    }
    const unavailableCheck = check as UnavailableSource;
    return [check.label, {error: unavailableCheck.error, statusCode: unavailableCheck.statusCode}];
  }));
  const unavailable = checks
    .filter((check): check is UnavailableSource => !check.ok)
    .map((check) => ({
      source: check.label,
      error: check.error,
      statusCode: check.statusCode,
    }));

  return {
    collectedAt: now.toISOString(),
    coverage: {
      unavailable,
      checked: checks.map((check) => check.label),
      git: options.skipGit ? 'skipped' : 'attempted',
    },
    sources,
    localGit: collectLocalGitSummary({skipGit: options.skipGit, cwd: options.cwd}),
  };
}
