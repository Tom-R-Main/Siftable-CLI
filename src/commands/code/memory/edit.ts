import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryEdit extends BaseCommand {
  static description = 'Edit a code memory in place; previous content stays in the audit ledger';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fact: Flags.string({description: 'Updated fact', required: true}),
    reason: Flags.string({description: 'Audit reason', required: true}),
    confidence: Flags.string({description: 'Confidence 0-1'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryEdit);
    const client = await this.client(flags);
    const response = await client.editCodeMemory(args.id, {
      fact: flags.fact,
      reason: flags.reason,
      confidence: flags.confidence ? Number(flags.confidence) : undefined,
      actorType: 'human',
    }, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Edited ${response.data?.id} → ${response.data?.lifecycle?.state}`);
    }

    return response.data;
  }
}
