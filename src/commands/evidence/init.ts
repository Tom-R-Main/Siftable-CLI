import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {EVIDENCE_PACKS, EVIDENCE_TEMPLATES, EvidencePack, evidenceDatasetFields} from '../../lib/evidence.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class EvidenceInit extends BaseCommand {
  static description = 'Create an Evidence Graph project and dataset-backed working tables';

  static args = {
    name: Args.string({description: 'Evidence Graph project name', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    pack: Flags.string({description: 'Evidence workflow pack', options: [...EVIDENCE_PACKS], default: 'company-origin'}),
    'dry-run': Flags.boolean({description: 'Preview project/dataset creation without writing'}),
    yes: Flags.boolean({description: 'Confirm creation without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceInit);
    const pack = flags.pack as EvidencePack;
    const plannedDatasets = EVIDENCE_TEMPLATES.map((template) => ({
      template,
      title: `${args.name} ${template.replace(/^evidence_/, '').replaceAll('_', ' ')}`,
      fields: evidenceDatasetFields(template),
    }));

    if (flags['dry-run']) {
      const result = {
        ok: true,
        dryRun: true,
        pack,
        project: {name: args.name, status: 'active'},
        datasets: plannedDatasets,
        policy: evidencePolicy(),
      };
      if (!this.jsonEnabled()) {
        renderDetail([
          ['Project', args.name],
          ['Pack', pack],
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
      `Create Evidence Graph project "${args.name}" and ${plannedDatasets.length} datasets?`,
      flags,
    );
    if (!confirmed) {
      this.log('Evidence Graph init cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const projectResponse = await client.createProject({
      name: args.name,
      summary: `Evidence Graph workspace initialized by Siftable CLI (${pack}).`,
      status: 'active',
      emoji: 'E',
    });
    this.handleApiError(projectResponse);
    const project = this.unwrapOne(projectResponse, 'project');

    const datasets = [];
    for (const dataset of plannedDatasets) {
      const response = await client.createDataset({
        title: dataset.title,
        description: `${dataset.template} working table for ${args.name}`,
        fields: dataset.fields,
        metadata: {
          evidenceGraphProjectId: project.id,
          evidencePack: pack,
          datasetTemplate: dataset.template,
          trustPolicy: evidencePolicy(),
        },
      });
      this.handleApiError(response);
      datasets.push(this.unwrapOne(response, 'dataset'));
    }

    const result = {ok: true, dryRun: false, pack, project, datasets, policy: evidencePolicy()};
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Project ID', project.id],
        ['Pack', pack],
        ['Datasets', datasets.length],
      ]);
    }
    return result;
  }
}

function evidencePolicy(): Record<string, unknown> {
  return {
    storage: 'dataset-backed',
    agentsMay: ['propose_rows', 'create_work_items', 'persist_diff_plans', 'run_verification', 'draft_proof_reports'],
    agentsMustNot: ['apply_durable_assertions', 'accept_claims', 'merge_identities', 'resolve_contradictions', 'delete_evidence'],
    projectionRequiresReview: true,
  };
}
