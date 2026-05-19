import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {RESEARCH_TEMPLATES, researchDatasetFields} from '../../lib/research.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class ResearchInit extends BaseCommand {
  static description = 'Create a research project and standard datasets';

  static args = {
    name: Args.string({description: 'Research project name', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    template: Flags.string({description: 'Research template', options: ['historical-research'], default: 'historical-research'}),
    'dry-run': Flags.boolean({description: 'Preview project/dataset creation without writing'}),
    yes: Flags.boolean({description: 'Confirm creation without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ResearchInit);
    const plannedDatasets = RESEARCH_TEMPLATES.map((template) => ({
      template,
      title: `${args.name} ${template}`,
      fields: researchDatasetFields(template),
    }));

    if (flags['dry-run']) {
      const result = {ok: true, dryRun: true, project: {name: args.name, status: 'active'}, datasets: plannedDatasets};
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Project', args.name],
          ['Dry run', 'yes'],
          ['Datasets', plannedDatasets.length],
        ]);
        renderTable(plannedDatasets as unknown as Record<string, unknown>[], [
          {key: 'template', header: 'Template'},
          {key: 'title', header: 'Dataset'},
          {key: 'fields', header: 'Fields', get: (row) => Array.isArray(row.fields) ? String(row.fields.length) : '0'},
        ]);
      }
      return result;
    }

    const confirmed = await this.confirmAction(
      `Create research project "${args.name}" and ${plannedDatasets.length} datasets?`,
      flags,
    );
    if (!confirmed) {
      this.log('Research init cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const projectResponse = await client.createProject({
      name: args.name,
      summary: `Research workspace initialized by Siftable CLI (${flags.template}).`,
      status: 'active',
      emoji: 'R',
    });
    this.handleApiError(projectResponse);
    const project = this.unwrapOne(projectResponse, 'project');

    const datasets = [];
    for (const dataset of plannedDatasets) {
      const response = await client.createDataset({
        title: dataset.title,
        description: `${dataset.template} dataset for ${args.name}`,
        fields: dataset.fields,
        metadata: {
          researchProjectId: project.id,
          researchTemplate: flags.template,
          datasetTemplate: dataset.template,
        },
      });
      this.handleApiError(response);
      datasets.push(this.unwrapOne(response, 'dataset'));
    }

    const result = {ok: true, dryRun: false, project, datasets};
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Project ID', project.id],
        ['Datasets', datasets.length],
      ]);
    }
    return result;
  }
}
