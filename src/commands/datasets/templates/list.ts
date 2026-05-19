import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class DatasetsTemplatesList extends BaseCommand {
  static description = 'List built-in dataset templates';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsTemplatesList);
    const client = await this.client(flags);
    const response = await client.listDatasetTemplates();
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderTable((result.templates ?? []) as Record<string, unknown>[], [
        {key: 'name', header: 'Template'},
        {key: 'fieldCount', header: 'Fields', get: (row) => String(row.fieldCount ?? 0)},
        {key: 'requiredFields', header: 'Required', get: (row) => Array.isArray(row.requiredFields) ? row.requiredFields.join(', ') : '—'},
        {key: 'requiredProvenance', header: 'Provenance', get: (row) => row.requiredProvenance ? 'yes' : 'no'},
      ]);
    }

    return result;
  }
}
