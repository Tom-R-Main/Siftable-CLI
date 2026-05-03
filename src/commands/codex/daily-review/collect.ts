import {Flags} from '@oclif/core';
import {execFileSync} from 'node:child_process';
import {BaseCommand} from '../../../lib/base-command.js';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

async function capture<T>(
  label: string,
  operation: () => Promise<{data?: T; error?: string; statusCode: number}>,
): Promise<{label: string; ok: true; data?: T} | {label: string; ok: false; error: string; statusCode: number}> {
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

export default class CodexDailyReviewCollect extends BaseCommand {
  static description = 'Collect read-only Siftable and local git context for Codex daily work reviews';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum records per source', default: 20}),
    'calendar-days': Flags.integer({description: 'Calendar lookahead days', default: 7}),
    'skip-git': Flags.boolean({description: 'Skip local git summary'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodexDailyReviewCollect);
    const client = await this.client(flags);
    const now = new Date();
    const calendarEnd = new Date(now);
    calendarEnd.setDate(calendarEnd.getDate() + flags['calendar-days']);

    const checks = await Promise.all([
      capture('projects', () => client.listProjects({includeArchived: false})),
      capture('agents', () => client.listAgents({includeDisabled: true})),
      capture('workItems', () => client.listWorkItems({limit: flags.limit})),
      capture('tasksInProgress', () => client.listTasks({status: 'in_progress', limit: flags.limit})),
      capture('tasksOpenPhase', () => client.listTasks({phase: 'open', limit: flags.limit})),
      capture('codeRepositories', () => client.listCodeRepositories()),
      capture('codeMemories', () => client.listCodeMemories({limit: flags.limit})),
      capture('calendar', () => client.listCalendarEvents({
        startDate: now.toISOString(),
        endDate: calendarEnd.toISOString(),
        limit: flags.limit,
      })),
      capture('vaultMetadata', () => client.listVaultEntries({limit: flags.limit})),
    ]);

    const sources = Object.fromEntries(checks.map((check) => [
      check.label,
      check.ok ? check.data : {error: check.error, statusCode: check.statusCode},
    ]));
    const unavailable = checks
      .filter((check): check is Extract<typeof check, {ok: false}> => !check.ok)
      .map((check) => ({
        source: check.label,
        error: check.error,
        statusCode: check.statusCode,
      }));

    const localGit = flags['skip-git']
      ? {skipped: true}
      : {
        repositoryRoot: git(['rev-parse', '--show-toplevel']),
        branch: git(['branch', '--show-current']),
        head: git(['rev-parse', '--short', 'HEAD']),
        status: git(['status', '--short']),
        stashes: git(['stash', 'list']),
        recentCommits: git(['log', '--since=yesterday 00:00', '--pretty=format:%h%x09%ad%x09%s', '--date=iso', '--max-count=20']),
        filesChangedThisWeek: git(['log', '--since=monday 00:00', '--name-only', '--pretty=format:', '--max-count=100']),
      };

    const report = {
      collectedAt: now.toISOString(),
      coverage: {
        unavailable,
        checked: checks.map((check) => check.label),
        git: flags['skip-git'] ? 'skipped' : 'attempted',
      },
      sources,
      localGit,
    };

    if (!this.jsonEnabled()) {
      this.log(JSON.stringify(report, null, 2));
    }

    return report;
  }
}
