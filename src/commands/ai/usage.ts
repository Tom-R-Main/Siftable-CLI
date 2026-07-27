import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import type {AiTransport} from '../../lib/ai-transport.js';
import {renderTable} from '../../lib/output.js';

export default class AiUsage extends BaseCommand {
  static description = 'Show connected-model usage totals (requires ai:usage:read)';
  static requiredScope = 'ai:usage:read';
  static flags = {
    ...BaseCommand.baseFlags,
    from: Flags.string({description: 'ISO-8601 period start'}),
    to: Flags.string({description: 'ISO-8601 period end'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AiUsage);
    const client: AiTransport = await this.client(flags);
    const result = await client.getAiUsage({from: flags.from, to: flags.to});
    this.handleAiApiError(result, 'ai:usage:read');
    const usage = result.data?.usage;
    if (!usage) this.error('AI usage summary was unavailable.');
    const output = {
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      invocationCount: usage.invocationCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      siftableModelChargeMicros: usage.siftableModelChargeMicros,
      externalProviderCostMicros: usage.externalProviderCostMicros,
    };
    if (!this.jsonEnabled()) {
      renderTable([output], [
        {key: 'periodStart', header: 'FROM'},
        {key: 'periodEnd', header: 'TO'},
        {key: 'invocationCount', header: 'CALLS'},
        {key: 'inputTokens', header: 'INPUT'},
        {key: 'outputTokens', header: 'OUTPUT'},
        {key: 'siftableModelChargeMicros', header: 'SIFT µUSD'},
        {key: 'externalProviderCostMicros', header: 'PROVIDER µUSD'},
      ]);
    }
    return output;
  }
}
