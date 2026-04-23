import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class TasksPlanningUpdate extends BaseCommand {
  static description = 'Update CSN planning fields for a task';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'cynefin-domain': Flags.string({
      description: 'Cynefin domain',
      options: ['clear', 'complicated', 'complex', 'chaotic', 'aporetic'],
    }),
    'cynefin-confidence': Flags.string({description: 'Cynefin confidence (0-1)'}),
    'cynefin-source': Flags.string({
      description: 'Source of the planning classification',
      options: ['user', 'assistant', 'classifier'],
    }),
    'cynefin-rationale': Flags.string({description: 'Why this domain fits'}),
    reversibility: Flags.string({description: 'Reversibility score (0-1)'}),
    'duration-model': Flags.string({
      description: 'Duration model JSON, e.g. {"kind":"point","days":2}',
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksPlanningUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags['cynefin-domain'] !== undefined) updates.cynefinDomain = flags['cynefin-domain'];
    if (flags['cynefin-confidence'] !== undefined) updates.cynefinConfidence = Number(flags['cynefin-confidence']);
    if (flags['cynefin-source'] !== undefined) updates.cynefinSource = flags['cynefin-source'];
    if (flags['cynefin-rationale'] !== undefined) updates.cynefinRationale = flags['cynefin-rationale'];
    if (flags.reversibility !== undefined) updates.reversibility = Number(flags.reversibility);
    if (flags['duration-model'] !== undefined) {
      updates.durationModel = this.parseJsonFlag<Record<string, unknown>>(flags['duration-model'], 'duration-model');
    }

    const response = await client.updateTaskPlanning(args.id, updates, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      const planning = (response.data as Record<string, any>)?.planning ?? {};
      renderDetail([
        ['Task', args.id],
        ['Domain', planning.cynefinDomain ?? '—'],
        ['Confidence', planning.cynefinConfidence ?? '—'],
        ['Reversibility', planning.reversibility ?? '—'],
        ['Criticality', planning.criticalityIndex ?? '—'],
      ]);
    }

    return response.data;
  }
}
