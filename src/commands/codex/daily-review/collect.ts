import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {collectDailyReviewContext} from '../../../lib/daily-review-context.js';

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
    const report = await collectDailyReviewContext(client, {
      limit: flags.limit,
      calendarDays: flags['calendar-days'],
      skipGit: flags['skip-git'],
    });

    if (!this.jsonEnabled()) {
      this.log(JSON.stringify(report, null, 2));
    }

    return report;
  }
}
