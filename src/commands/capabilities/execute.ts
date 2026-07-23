import {Flags} from '@oclif/core';
import {randomUUID} from 'node:crypto';
import {BaseCommand} from '../../lib/base-command.js';
import {parseJsonObject} from '../../lib/capability-input.js';

export default class CapabilitiesExecute extends BaseCommand {
  static description = 'Execute one typed operation through a Vault capability handle';

  static flags = {
    ...BaseCommand.baseFlags,
    handle: Flags.string({description: 'Opaque vcap_ capability handle', required: true}),
    operation: Flags.string({description: 'Allowlisted operation', required: true}),
    input: Flags.string({description: 'Typed operation input JSON object', default: '{}'}),
    approval: Flags.string({description: 'Governed approval UUID when required'}),
    'idempotency-key': Flags.string({
      description: 'Stable 8-128 character key for safe retries',
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CapabilitiesExecute);
    const response = await this.apiRequest<{receipt: Record<string, unknown>}>(
      flags,
      '/api/v1/vault/capabilities/execute',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          handle: flags.handle,
          operation: flags.operation,
          input: parseJsonObject(flags.input, '--input'),
          approvalId: flags.approval,
          idempotencyKey: flags['idempotency-key'] ?? randomUUID(),
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Execution: ${response.receipt.executionId}`);
      this.log(`Result class: ${response.receipt.resultClass}`);
      this.log(JSON.stringify(response.receipt.result, null, 2));
      if (response.receipt.reused) this.log('Idempotent replay: reused the prior safe receipt.');
    }
    return response.receipt;
  }
}
