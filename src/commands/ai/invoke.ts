import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import type {AiTransport} from '../../lib/ai-transport.js';

export default class AiInvoke extends BaseCommand {
  static description = 'Invoke an eligible connected model (requires ai:invoke and ai:connections:use)';
  static requiredScope = 'ai:invoke';
  static flags = {
    ...BaseCommand.baseFlags,
    connection: Flags.string({
      description: 'Model Connection UUID returned by sift ai list',
      required: true,
    }),
    model: Flags.string({
      description: 'Eligible model ID returned by sift ai list',
      required: true,
    }),
    prompt: Flags.string({
      description: 'Prompt text',
      required: true,
    }),
    'max-output-tokens': Flags.integer({
      description: 'Maximum output tokens (1-32768)',
      min: 1,
      max: 32_768,
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AiInvoke);
    const client = await this.client(flags) as unknown as AiTransport;
    const result = await client.generateAi({
      connectionId: flags.connection,
      model: flags.model,
      prompt: flags.prompt,
      maxOutputTokens: flags['max-output-tokens'],
    });
    this.handleApiError(result);
    const response = result.data?.response;
    if (!response) this.error('AI response was unavailable.');
    const output = {
      connectionId: response.connectionId,
      model: response.model,
      text: response.text,
      finishReason: response.finishReason,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
    if (!this.jsonEnabled()) this.log(output.text);
    return output;
  }
}
