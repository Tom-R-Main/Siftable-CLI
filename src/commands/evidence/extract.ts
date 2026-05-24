import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {buildEvidenceExtractionWork, EVIDENCE_PACKS, EvidencePack, parseEvidenceTargets} from '../../lib/evidence.js';
import {renderDetail} from '../../lib/output.js';

export default class EvidenceExtract extends BaseCommand {
  static description = 'Create no-apply agent work for Evidence Graph candidate extraction';

  static flags = {
    ...BaseCommand.baseFlags,
    pack: Flags.string({description: 'Evidence workflow pack', options: [...EVIDENCE_PACKS], default: 'company-origin'}),
    targets: Flags.string({description: 'Comma-separated extraction targets'}),
    project: Flags.string({description: 'Project ID'}),
    agent: Flags.string({description: 'Assigned agent alias', default: 'researcher'}),
    'source-dataset': Flags.string({description: 'Evidence sources dataset ID', required: true}),
    context: Flags.string({description: 'Additional input context JSON object'}),
    'context-file': Flags.string({description: 'Additional input context JSON file'}),
    'no-apply': Flags.boolean({description: 'Keep extraction in proposed/diff-first mode', default: true}),
    'dry-run': Flags.boolean({description: 'Preview work item payload without writing'}),
    yes: Flags.boolean({description: 'Confirm work item creation without prompting'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EvidenceExtract);
    if (!flags['no-apply']) {
      this.error('Evidence extraction is no-apply in v1. Durable assertions must go through diff review.');
    }
    let targets;
    try {
      targets = parseEvidenceTargets(flags.targets);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid evidence extraction targets.');
    }
    const extraContext = this.parseJsonInput<Record<string, unknown>>(flags.context, flags['context-file'], 'context') ?? {};
    const work = buildEvidenceExtractionWork({
      pack: flags.pack as EvidencePack,
      targets,
      sourceDatasetId: flags['source-dataset'],
      projectId: flags.project,
      context: extraContext,
    });
    const payload = {
      title: work.title,
      prompt: work.prompt,
      assignedAlias: flags.agent,
      projectId: flags.project,
      inputContext: {
        workflow: 'evidence_graph',
        pack: flags.pack,
        targets,
        sourceDatasetId: flags['source-dataset'],
        noApply: true,
        ...extraContext,
      },
      acceptanceCriteria: work.acceptanceCriteria,
      writeScope: work.writeScope,
      verificationCommands: work.verificationCommands,
    };

    if (flags['dry-run']) {
      const result = {ok: true, dryRun: true, workItem: payload};
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Pack', flags.pack],
          ['Targets', targets.join(', ')],
          ['Dry run', 'yes'],
        ]);
      }
      return result;
    }

    const confirmed = await this.confirmAction(`Create Evidence Graph extraction work item "${work.title}"?`, flags);
    if (!confirmed) {
      this.log('Evidence extraction cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.createWorkItem(payload, this.idempotencyKey());
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    const result = {
      ok: true,
      workItem,
      policy: {
        noApply: true,
        reviewRequired: true,
      },
      next: [
        `sift work get ${workItem.id} --json`,
        `sift work claim --agent ${flags.agent} --json`,
      ],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Work item', workItem.id],
        ['Agent', flags.agent],
        ['No apply', 'yes'],
      ]);
    }
    return result;
  }
}
