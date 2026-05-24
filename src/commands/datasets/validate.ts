import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

const TEMPLATE_OPTIONS = [
  'sources',
  'people',
  'events',
  'claims',
  'evidence_sources',
  'evidence_source_fragments',
  'evidence_claims',
  'evidence_people',
  'evidence_organizations',
  'evidence_places',
  'evidence_artifacts',
  'evidence_events',
  'evidence_relationships',
  'evidence_contradictions',
];

export default class DatasetsValidate extends BaseCommand {
  static description = 'Validate a dataset against a built-in template';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    template: Flags.string({
      description: 'Built-in template name',
      options: TEMPLATE_OPTIONS,
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsValidate);
    const client = await this.client(flags);
    const response = await client.validateDataset(args.id, {template: flags.template});
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Template', result.template],
        ['Valid', result.valid],
      ]);
      const issues = [
        ...((result.errors ?? []) as Record<string, unknown>[]),
        ...((result.warnings ?? []) as Record<string, unknown>[]),
      ];
      if (issues.length > 0) {
        this.log('');
        renderTable(issues, [
          {key: 'severity', header: 'Severity'},
          {key: 'type', header: 'Type'},
          {key: 'field', header: 'Field'},
          {key: 'message', header: 'Message'},
        ]);
      }
    }

    return result;
  }
}
