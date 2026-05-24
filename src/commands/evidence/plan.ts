import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {buildEvidencePlan, EVIDENCE_PACKS, EvidencePack} from '../../lib/evidence.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class EvidencePlan extends BaseCommand {
  static description = 'Plan an Evidence Graph workflow before writing trusted state';

  static args = {
    goal: Args.string({description: 'Evidence Graph goal', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    pack: Flags.string({description: 'Evidence workflow pack', options: [...EVIDENCE_PACKS], default: 'company-origin'}),
    project: Flags.string({description: 'Existing project ID'}),
    'source-dataset': Flags.string({description: 'Existing evidence sources dataset ID'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidencePlan);
    const plan = buildEvidencePlan(args.goal, {
      pack: flags.pack as EvidencePack,
      projectId: flags.project,
      sourceDatasetId: flags['source-dataset'],
    });
    const result = {ok: true, plan};

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Goal', plan.goal],
        ['Pack', plan.pack],
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
