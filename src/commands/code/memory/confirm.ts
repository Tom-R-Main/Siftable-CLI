import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryConfirm extends BaseCommand {
  static description = 'Confirm a code memory candidate with an auditable reason';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reason: Flags.string({description: 'Audit reason', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryConfirm);
    const client = await this.client(flags);
    const response = await client.confirmCodeMemory(args.id, {
      reason: flags.reason,
      actorType: 'human',
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Confirmed ${response.data?.id} → ${response.data?.lifecycle?.state}`);
    }

    return response.data;
  }
}
