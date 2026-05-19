import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {RESEARCH_RUNS} from '../../lib/research.js';
import {renderDetail} from '../../lib/output.js';

export default class ResearchRun extends BaseCommand {
  static description = 'Create deterministic agent work for a research recipe';

  static args = {
    recipe: Args.string({
      description: 'Research run recipe',
      options: Object.keys(RESEARCH_RUNS),
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Project ID'}),
    agent: Flags.string({description: 'Assigned agent alias', default: 'researcher'}),
    'source-dataset': Flags.string({description: 'Source dataset ID'}),
    context: Flags.string({description: 'Additional input context JSON object'}),
    'context-file': Flags.string({description: 'Additional input context JSON file'}),
    'dry-run': Flags.boolean({description: 'Preview work item payload without writing'}),
    yes: Flags.boolean({description: 'Confirm work item creation without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ResearchRun);
    const recipe = RESEARCH_RUNS[args.recipe];
    const extraContext = this.parseJsonInput<Record<string, unknown>>(flags.context, flags['context-file'], 'context') ?? {};
    const inputContext = {
      recipe: args.recipe,
      sourceDatasetId: flags['source-dataset'],
      ...extraContext,
    };
    const payload = {
      title: recipe.title,
      prompt: recipe.prompt,
      assignedAlias: flags.agent,
      projectId: flags.project,
      inputContext,
      acceptanceCriteria: recipe.acceptanceCriteria,
      writeScope: {
        ...recipe.writeScope,
        sourceDatasetId: flags['source-dataset'],
      },
      verificationCommands: recipe.verificationCommands,
    };

    if (flags['dry-run']) {
      const result = {ok: true, dryRun: true, workItem: payload};
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Recipe', args.recipe],
          ['Title', recipe.title],
          ['Dry run', 'yes'],
        ]);
      }
      return result;
    }

    const confirmed = await this.confirmAction(`Create research work item "${recipe.title}"?`, flags);
    if (!confirmed) {
      this.log('Research run cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.createWorkItem(payload, this.idempotencyKey());
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    const result = {
      ok: true,
      recipe: args.recipe,
      workItem,
      next: [
        `sift work get ${workItem.id} --json`,
        `sift work claim --agent ${flags.agent} --json`,
      ],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Recipe', args.recipe],
        ['Work item', workItem.id],
        ['Agent', flags.agent],
      ]);
    }

    return result;
  }
}
