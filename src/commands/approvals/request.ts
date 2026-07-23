import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

function parseDestination(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--destination must be a JSON object');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('--destination must be a JSON object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([, item]) => typeof item === 'string')) {
    throw new Error('--destination values must be strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export default class ApprovalsRequest extends BaseCommand {
  static description = 'Request a governed action approval; this command cannot approve or consume it';

  static flags = {
    ...BaseCommand.baseFlags,
    action: Flags.string({description: 'Governed action identifier', required: true}),
    purpose: Flags.string({description: 'Human-readable non-secret purpose', required: true}),
    'resource-type': Flags.string({description: 'Resource type identifier', required: true}),
    'resource-id': Flags.string({description: 'Resource identifier', required: true}),
    operation: Flags.string({description: 'Operation identifier', required: true}),
    destination: Flags.string({description: 'Destination binding JSON object', default: '{}'}),
    'expires-in': Flags.integer({description: 'Approval lifetime in seconds (30-600)'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ApprovalsRequest);
    const response = await this.apiRequest<{approval: Record<string, unknown>}>(
      flags,
      '/api/v1/governed-approvals',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          action: flags.action,
          purpose: flags.purpose,
          resourceType: flags['resource-type'],
          resourceId: flags['resource-id'],
          operation: flags.operation,
          destination: parseDestination(flags.destination),
          expiresInSeconds: flags['expires-in'],
        },
      },
    );
    const approval = response.approval;
    if (!this.jsonEnabled()) {
      this.log(`Approval requested: ${approval.id}`);
      this.log(`Status: ${approval.status}`);
      this.log(`Expires: ${approval.expiresAt}`);
      this.log('Approve or deny this request at /app/governed-approvals in the first-party Siftable browser.');
    }
    return approval;
  }
}
