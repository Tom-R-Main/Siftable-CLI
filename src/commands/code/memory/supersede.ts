import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemorySupersede extends BaseCommand {
  static description = 'Supersede a code memory with a new fact; old memory retained as lineage';

  static args = {
    id: Args.string({description: 'Memory ID to supersede', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fact: Flags.string({description: 'Replacement fact', required: true}),
    reason: Flags.string({description: 'Audit reason', required: true}),
    category: Flags.string({
      description: 'Fact category (defaults to previous)',
      options: ['architecture', 'integration', 'convention', 'entrypoint', 'gotcha', 'ownership'],
    }),
    file: Flags.string({description: 'Related file path'}),
    path: Flags.string({description: 'Additional related path (repeatable)', multiple: true}),
    'evidence-chunk': Flags.string({
      description: 'Evidence chunk ID (repeatable)',
      multiple: true,
    }),
    confidence: Flags.string({description: 'Confidence 0-1'}),
    commit: Flags.string({description: 'Source commit SHA'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemorySupersede);
    const client = await this.client(flags);
    const response = await client.supersedeCodeMemory(args.id, {
      fact: flags.fact,
      reason: flags.reason,
      category: flags.category,
      filePath: flags.file,
      paths: flags.path,
      evidenceChunkIds: flags['evidence-chunk'],
      confidence: flags.confidence ? Number(flags.confidence) : undefined,
      sourceCommit: flags.commit,
      actorType: 'human',
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(
        `Superseded ${response.data?.previous?.id} → ${response.data?.current?.id}` +
        ` (${response.data?.current?.lifecycle?.state})`,
      );
    }

    return response.data;
  }
}
