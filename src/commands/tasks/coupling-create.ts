import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksCouplingCreate extends BaseCommand {
  static description = 'Create a CSN coupling edge between tasks in the same project';

  static args = {
    id: Args.string({description: 'Source task ID', required: true}),
    target: Args.string({description: 'Target task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    type: Flags.string({
      description: 'Coupling type',
      options: ['info', 'resource'],
      required: true,
    }),
    strength: Flags.string({description: 'Coupling strength (0-1)'}),
    note: Flags.string({description: 'Optional note'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksCouplingCreate);
    const client = await this.client(flags);
    const response = await client.createTaskCouplingEdge(
      args.id,
      {
        targetTaskId: args.target,
        couplingType: flags.type as 'info' | 'resource',
        strength: flags.strength !== undefined ? Number(flags.strength) : undefined,
        note: flags.note ?? undefined,
      },
      this.idempotencyKey()
    );
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      const edge = (response.data as Record<string, any>)?.edge ?? {};
      this.log(`Coupling created: ${edge.sourceTaskId ?? args.id} -> ${edge.targetTaskId ?? args.target} [${edge.couplingType ?? flags.type}]`);
    }

    return response.data;
  }
}
