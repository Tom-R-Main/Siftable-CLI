import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {createGitReader, type GitReader} from '../../lib/work-coverage/bind.js';
import {MAX_CANDIDATES} from '../../lib/work-coverage/payload.js';
import {runCoverageShadow, type CoverageShadowSummary} from '../../lib/work-coverage/run.js';

export default class WorkCoverageShadow extends BaseCommand {
  static description = 'Post the test cases a work item\'s verification plan runs, for Jev coverage shadow evaluation';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    commit: Flags.string({description: 'Commit to read test files at (default: HEAD of this checkout)'}),
    'dry-run': Flags.boolean({description: 'Print the candidate summary and payload size without posting'}),
    save: Flags.string({description: 'Also write the built payload as JSON to this file (with or without --dry-run)'}),
  };

  protected gitReader(): GitReader {
    return createGitReader(process.cwd());
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkCoverageShadow);
    const result = await runCoverageShadow({
      workItemId: args.id,
      commitRef: flags.commit,
      dryRun: flags['dry-run'],
      savePath: flags.save,
      git: this.gitReader(),
      request: (path, options) => (options ? this.apiRequest(flags, path, options) : this.apiRequest(flags, path)),
    });

    if (result.outcome === 'too_broad') {
      this.printSummary(result.summary,
        `too_broad: ${result.summary.candidates} candidates exceed ${MAX_CANDIDATES}; nothing was posted`);
      return {status: 'too_broad', posted: false, ...result.summary};
    }
    if (result.outcome === 'dry_run') {
      this.printSummary(result.summary, 'dry run: nothing was posted');
      return {status: 'dry_run', posted: false, ...result.summary};
    }

    const {response, summary} = result;
    if (!this.jsonEnabled()) {
      this.log(`Coverage shadow: ${response.status}${response.recordId ? ` (record ${response.recordId})` : ''}`);
      this.log(`Candidates ${summary.candidates}, criteria ${response.criteria}, requests ${response.requests}`);
      if (summary.savedTo) this.log(`Payload saved to ${summary.savedTo}`);
    }
    return {...response, posted: true, summary};
  }

  private printSummary(summary: CoverageShadowSummary, outcome: string): void {
    if (this.jsonEnabled()) return;
    this.log(`Commit ${summary.commit}, plan v${summary.planVersion}`);
    this.log(`Candidates ${summary.candidates} (skipped cases left out: ${summary.skippedCases}; not selected by a test-name filter: ${summary.filteredCases}) from ${summary.files.length} file(s)`);
    for (const file of summary.files) this.log(`  ${file}`);
    this.log(summary.candidatesComplete ? 'Candidate list complete' : 'Candidate list incomplete:');
    for (const reason of summary.incompleteReasons) this.log(`  ${reason}`);
    this.log(`Payload ${summary.payloadBytes} bytes`);
    if (summary.savedTo) this.log(`Payload saved to ${summary.savedTo}`);
    this.log(outcome);
  }
}
