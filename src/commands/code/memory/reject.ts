import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryReject extends BaseCommand {
  static description = 'Reject a code memory with an auditable reason (soft-reject; never deletes)';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reason: Flags.string({description: 'Audit reason', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryReject);
    const client = await this.client(flags);
    const response = await client.rejectCodeMemory(args.id, {
      reason: flags.reason,
      actorType: 'human',
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Rejected ${response.data?.id} → ${response.data?.lifecycle?.state}`);
    }

    return response.data;
  }
}
