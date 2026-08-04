import {BaseCommand} from '../lib/base-command.js';
import {STATIC_READINESS_CAPABILITIES} from '../lib/capabilities.js';
import {renderTable} from '../lib/output.js';

export default class Capabilities extends BaseCommand {
  static description = 'Show Siftable CLI capabilities and readiness status';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(Capabilities);
    const result = {
      ok: true,
      kind: 'static_readiness',
      selection: {
        command: 'sift capabilities',
        executable: false,
        executableHandleSurface: 'sift capabilities list',
      },
      capabilities: STATIC_READINESS_CAPABILITIES,
    };

    if (!this.jsonEnabled()) {
      renderTable(STATIC_READINESS_CAPABILITIES as unknown as Record<string, unknown>[], [
        {key: 'id', header: 'Capability'},
        {key: 'status', header: 'Status'},
        {key: 'description', header: 'Description'},
      ]);
    }

    return result;
  }
}
