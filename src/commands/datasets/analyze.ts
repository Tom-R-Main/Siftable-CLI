import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsAnalyze extends BaseCommand {
  static description = 'Generate grounded natural-language insights for a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'focus-fields': Flags.string({description: 'Comma-separated field names to focus analysis on'}),
    'max-insights': Flags.integer({description: 'Max insights to generate', default: 5}),
    filters: Flags.string({description: 'JSON array of filters'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsAnalyze);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {maxInsights: flags['max-insights']};
    if (flags['focus-fields']) options.focusFields = flags['focus-fields'].split(',').map((s) => s.trim());
    if (flags.filters) options.filters = JSON.parse(flags.filters);

    const response = await client.analyzeDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      for (const insight of (data?.insights ?? [])) {
        this.log(`• ${insight.claim}`);
      }
    }

    return response.data;
  }
}
