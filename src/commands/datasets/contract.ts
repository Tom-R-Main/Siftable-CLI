import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class DatasetsContract extends BaseCommand {
  static description = 'Show an agent-readable dataset schema and capabilities contract';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    template: Flags.string({description: 'Validate contract against a built-in template'}),
    resolve: Flags.string({description: 'Comma-separated semantic field references to resolve'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsContract);
    const client = await this.client(flags);
    const resolve = flags.resolve
      ? flags.resolve.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined;
    const response = await client.getDatasetContract(args.id, {
      template: flags.template,
      resolve,
    });
    this.handleApiError(response);
    const contract = response.data as Record<string, any>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', contract.datasetId],
        ['Title', contract.dataset?.title],
        ['Rows', contract.dataset?.rowCount],
        ['Contract', contract.contractVersion],
        ['Lifecycle', contract.lifecycle?.kind],
        ['Import', contract.capabilities?.import],
        ['Mutation', contract.capabilities?.mutate],
        ['Diff Plans', contract.capabilities?.diffPlans ? 'yes' : 'no'],
        ['Formula Fields', contract.capabilities?.formulas?.fieldCount ?? 0],
        ['Graph Projection', contract.capabilities?.graph?.projection],
      ]);

      this.log('');
      renderTable((contract.schema?.fields ?? []) as Record<string, unknown>[], [
        {key: 'name', header: 'Field'},
        {key: 'type', header: 'Type'},
        {key: 'required', header: 'Required', get: (row) => row.required ? 'yes' : 'no'},
        {key: 'unique', header: 'Unique', get: (row) => row.unique ? 'yes' : 'no'},
        {key: 'capabilities', header: 'Safe Edit', get: (row) => (row.capabilities as any)?.editable ? 'yes' : 'no'},
      ]);

      const resolutions = contract.fieldResolution?.requested ?? [];
      if (Array.isArray(resolutions) && resolutions.length > 0) {
        this.log('');
        renderTable(resolutions as Record<string, unknown>[], [
          {key: 'input', header: 'Input'},
          {key: 'fieldName', header: 'Field'},
          {key: 'strategy', header: 'Strategy'},
          {key: 'confidence', header: 'Confidence', get: (row) => String(row.confidence ?? 0)},
        ]);
      }
    }

    return contract;
  }
}
