import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {CAPABILITIES} from '../../lib/capabilities.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class ResearchStatus extends BaseCommand {
  static description = 'Inspect research project context and CLI readiness';

  static args = {
    project: Args.string({description: 'Project ID', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ResearchStatus);
    let context: unknown;
    if (args.project) {
      const client = await this.client(flags);
      const response = await client.getProjectContext(args.project);
      this.handleApiError(response);
      context = response.data;
    }

    const result = {
      ok: true,
      projectId: args.project,
      context,
      readiness: CAPABILITIES,
      next: [
        'Run `sift research plan "<goal>" --json` before writing.',
        'Run `sift datasets templates list --json` to inspect table contracts.',
        'Use `sift research run <recipe> --dry-run --json` before queuing agent work.',
      ],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Project ID', args.project],
        ['Capabilities', CAPABILITIES.length],
      ]);
      this.log('');
      renderTable(CAPABILITIES as unknown as Record<string, unknown>[], [
        {key: 'id', header: 'Capability'},
        {key: 'status', header: 'Status'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
