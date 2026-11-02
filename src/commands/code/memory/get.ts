import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryGet extends BaseCommand {
  static description = 'Show one code memory with provenance, evidence, and lifecycle';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryGet);
    const client = await this.client(flags);
    const response = await client.getCodeMemory(args.id);
    this.handleApiError(response);

    const memory = response.data;
    if (!this.jsonEnabled() && memory) {
      this.log(`ID: ${memory.id}`);
      this.log(`Fact: ${memory.content}`);
      this.log(`Category: ${memory.factType}`);
      this.log(`Lifecycle: ${memory.lifecycle?.state}`);
      this.log(`Confidence: ${memory.confidence}`);
      this.log(`Source: ${memory.source ?? 'unknown'}`);
      if (memory.authoringAgent) this.log(`Authoring agent: ${memory.authoringAgent}`);
      this.log(`Evidence: ${memory.evidence?.availability ?? 'not_recorded'}`);
    }

    return memory;
  }
}
