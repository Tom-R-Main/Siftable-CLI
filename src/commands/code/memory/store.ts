import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryStore extends BaseCommand {
  static description = 'Store a curated code fact';

  static flags = {
    ...BaseCommand.baseFlags,
    fact: Flags.string({description: 'Fact to store (1-2 sentences)', required: true}),
    category: Flags.string({
      description: 'Fact category',
      required: true,
      options: ['architecture', 'integration', 'convention', 'entrypoint', 'gotcha', 'ownership'],
    }),
    file: Flags.string({description: 'Related file path'}),
    path: Flags.string({description: 'Additional related path (repeatable)', multiple: true}),
    repo: Flags.string({description: 'Repository ID'}),
    'evidence-chunk': Flags.string({
      description: 'Historical indexed chunk ID supporting the fact',
      multiple: true,
    }),
    confidence: Flags.string({description: 'Confidence 0-1'}),
    agent: Flags.string({description: 'Authoring agent (marks memory as agent-authored)'}),
    reason: Flags.string({description: 'Capture reason (required with --agent)'}),
    commit: Flags.string({description: 'Source commit SHA'}),
    'work-item': Flags.string({description: 'Related agent work item ID'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodeMemoryStore);
    if (flags.agent && !flags.reason) {
      this.error('--reason is required when --agent is set');
    }
    const client = await this.client(flags);
    const response = await client.storeCodeMemory({
      fact: flags.fact,
      category: flags.category as 'architecture' | 'integration' | 'convention' | 'entrypoint' | 'gotcha' | 'ownership',
      filePath: flags.file,
      paths: flags.path,
      repositoryId: flags.repo,
      evidenceChunkIds: flags['evidence-chunk'],
      confidence: flags.confidence ? Number(flags.confidence) : undefined,
      source: flags.agent ? 'agent' : 'human',
      authoringAgent: flags.agent,
      captureReason: flags.reason,
      sourceCommit: flags.commit,
      workItemId: flags['work-item'],
    });
    this.handleApiError(response);

    const memory = response.data;

    if (!this.jsonEnabled()) {
      this.log(`Fact stored: ${memory?.id}`);
    }

    return response.data;
  }
}
