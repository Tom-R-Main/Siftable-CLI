import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {buildResearchPlan} from '../../lib/research.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class ResearchPlan extends BaseCommand {
  static description = 'Plan a deterministic research workflow before writing data';

  static args = {
    goal: Args.string({description: 'Research goal', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Existing project ID'}),
    'source-dataset': Flags.string({description: 'Existing sources dataset ID'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ResearchPlan);
    const plan = buildResearchPlan(args.goal, {
      projectId: flags.project,
      sourceDatasetId: flags['source-dataset'],
    });
    const result = {ok: true, plan};

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Goal', plan.goal],
        ['Steps', plan.steps.length],
      ]);
      this.log('');
      renderTable(plan.steps as unknown as Record<string, unknown>[], [
        {key: 'command', header: 'Command'},
        {key: 'purpose', header: 'Purpose'},
        {key: 'writes', header: 'Writes', get: (row) => row.writes ? 'yes' : 'no'},
      ]);
    }

    return result;
  }
}
